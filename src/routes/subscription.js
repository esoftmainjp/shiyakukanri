'use strict';

// 施設のご契約(プラン/課金)の確認・変更。施設管理者(admin)＋施設選択中のsuperadmin。
//   GET  /api/subscription/current   現在のプラン・課金状態・選択可能プラン
//   POST /api/subscription/change    プラン変更(有料↔有料は即時、無料→有料はCheckout、→無料は解約)
//   POST /api/subscription/portal    Stripe顧客ポータル(カード更新・解約)
//   POST /api/subscription/dev-apply 疑似決済での無料→有料反映(Stripe未設定・本番以外のみ)

const express = require('express');
const { pool } = require('../db');
const { facilityScope } = require('../services/facility');
const { writeLog } = require('../services/log');
const { appBaseUrl } = require('../services/signup');
const payments = require('../services/payments');

const router = express.Router();
const isProd = process.env.NODE_ENV === 'production';

// 操作対象の施設IDを解決(未選択のsuperadminは不可)
function facilityIdOf(req, res) {
  const scope = facilityScope(req);
  if (scope.all || scope.facilityId == null) {
    res.status(400).json({ error: '対象施設を選択してください' });
    return null;
  }
  return scope.facilityId;
}

async function loadFacility(facilityId) {
  const r = await pool.query(
    `SELECT f.id, f.name, f.plan_code, f.is_active, f.billing_status, f.current_period_end,
            f.stripe_customer_id, f.stripe_subscription_id,
            p.name AS plan_name, p.price
       FROM facilities f JOIN plans p ON p.code = f.plan_code
      WHERE f.id = $1`, [facilityId]);
  return r.rowCount ? r.rows[0] : null;
}

// 現在の契約・選択可能プラン
router.get('/current', async (req, res) => {
  const facilityId = facilityIdOf(req, res); if (facilityId == null) return;
  try {
    const facility = await loadFacility(facilityId);
    if (!facility) return res.status(404).json({ error: '施設が見つかりません' });
    const plans = (await pool.query(
      `SELECT code, name, price, max_users, max_products, log_retention_days,
              feat_stocktake, feat_barcode, feat_reports, feat_ledger, feat_import, feat_billing
         FROM plans ORDER BY sort_order, price, code`)).rows;
    const provider = await payments.active();
    res.json({ facility, plans, paymentMode: provider.key, providerLabel: provider.label });
  } catch (err) {
    console.error('契約取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// プラン変更
router.post('/change', async (req, res) => {
  const facilityId = facilityIdOf(req, res); if (facilityId == null) return;
  const planCode = String((req.body || {}).planCode || '').trim();
  try {
    const facility = await loadFacility(facilityId);
    if (!facility) return res.status(404).json({ error: '施設が見つかりません' });
    const pl = await pool.query('SELECT code, price, stripe_price_id FROM plans WHERE code = $1', [planCode]);
    if (pl.rowCount === 0) return res.status(400).json({ error: 'プランを選択してください' });
    const target = pl.rows[0];
    if (target.code === facility.plan_code) return res.status(400).json({ error: '既に同じプランです' });

    const hasSub = !!facility.stripe_subscription_id;
    const provider = await payments.active();
    const usable = provider.key !== 'mock' && provider.isConfigured();

    // (A) 無料へ変更 = 解約
    if (Number(target.price) === 0) {
      if (hasSub && usable) {
        try { await provider.cancelSubscription(facility.stripe_subscription_id); }
        catch (e) { console.error('[sub] 解約失敗:', e.message); }
      }
      await pool.query(
        `UPDATE facilities SET plan_code = 'free', billing_status = 'none', stripe_subscription_id = NULL WHERE id = $1`,
        [facilityId]);
      await writeLog(pool, { userId: req.session.user.id, targetTable: 'facilities', targetId: facilityId, operationType: '更新', before: { plan: facility.plan_code }, after: { plan: 'free', action: 'downgrade_free' }, facilityId });
      return res.json({ ok: true, mode: 'downgraded' });
    }

    // (B) 有料→有料(サブスクあり): 既存カードで即時変更(日割り)
    if (hasSub) {
      if (usable) {
        await provider.updateSubscriptionPlan(facility.stripe_subscription_id, target);
      }
      // 楽観反映(実プロバイダ構成時もWebフックで再同期される)
      await pool.query(`UPDATE facilities SET plan_code = $2, billing_status = 'active' WHERE id = $1`, [facilityId, target.code]);
      await writeLog(pool, { userId: req.session.user.id, targetTable: 'facilities', targetId: facilityId, operationType: '更新', before: { plan: facility.plan_code }, after: { plan: target.code, action: 'update_subscription' }, facilityId });
      return res.json({ ok: true, mode: 'updated' });
    }

    // (C) 無料→有料(サブスクなし): カード入力が必要
    if (provider.key === 'mock') {
      // 疑似モード(ローカル): フロントが dev-apply を叩く
      if (isProd) return res.status(503).json({ error: '有料プランへの変更は現在準備中です。お問い合わせください。' });
      return res.json({ ok: true, mode: 'mock', planCode: target.code });
    }
    if (!provider.isConfigured()) {
      return res.status(503).json({ error: `選択中の決済プロバイダ（${provider.label}）が未設定です。決済設定をご確認ください。` });
    }
    const base = appBaseUrl(req);
    const email = (await pool.query(
      `SELECT login_id FROM users WHERE facility_id = $1 AND user_type = 'admin' ORDER BY id LIMIT 1`, [facilityId])).rows[0];
    const session = await provider.createSubscriptionCheckout({
      email: email ? email.login_id : undefined,
      plan: target,
      successUrl: `${base}/plan.html?upgraded=1`,
      cancelUrl: `${base}/plan.html?canceled=1`,
      metadata: { facilityId: String(facilityId), planCode: target.code },
    });
    return res.json({ ok: true, mode: 'checkout', checkoutUrl: session.url });
  } catch (err) {
    console.error('プラン変更エラー:', err.status || '', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// 疑似決済での無料→有料反映(ローカル検証用)
router.post('/dev-apply', async (req, res) => {
  const provider = await payments.active();
  if (isProd || provider.key !== 'mock') return res.status(404).json({ error: 'not found' });
  const facilityId = facilityIdOf(req, res); if (facilityId == null) return;
  const planCode = String((req.body || {}).planCode || '').trim();
  try {
    const pl = await pool.query('SELECT code, price FROM plans WHERE code = $1', [planCode]);
    if (pl.rowCount === 0 || Number(pl.rows[0].price) === 0) return res.status(400).json({ error: 'プランが不正です' });
    await pool.query(
      `UPDATE facilities SET plan_code = $2, billing_status = 'active',
              stripe_customer_id = COALESCE(stripe_customer_id, $3),
              stripe_subscription_id = COALESCE(stripe_subscription_id, $4)
        WHERE id = $1`,
      [facilityId, planCode, 'sim_cus_fac_' + facilityId, 'sim_sub_fac_' + facilityId]);
    await writeLog(pool, { userId: req.session.user.id, targetTable: 'facilities', targetId: facilityId, operationType: '更新', after: { plan: planCode, action: 'mock_upgrade' }, facilityId });
    res.json({ ok: true, mode: 'upgraded' });
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// Stripe顧客ポータル(カード更新・解約・プラン変更をユーザー自身が操作)
router.post('/portal', async (req, res) => {
  const facilityId = facilityIdOf(req, res); if (facilityId == null) return;
  try {
    const facility = await loadFacility(facilityId);
    if (!facility || !facility.stripe_customer_id) return res.status(400).json({ error: 'ご契約情報がありません' });
    const provider = await payments.active();
    if (!provider.supportsPortal || !provider.isConfigured()) {
      return res.status(503).json({ error: `顧客ポータルは現在の決済プロバイダ（${provider.label}）では利用できません` });
    }
    const base = appBaseUrl(req);
    const p = await provider.createBillingPortal(facility.stripe_customer_id, `${base}/plan.html`);
    res.json({ ok: true, url: p.url });
  } catch (err) {
    console.error('ポータル作成エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
