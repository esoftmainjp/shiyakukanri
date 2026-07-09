'use strict';

// Stripe Webhook 受け口。server.js で express.raw を先に適用してマウントする。
//   checkout.session.completed     … 決済成功 → 施設＋管理者を自動作成
//   customer.subscription.updated  … プラン変更/状態変化 → 施設に同期
//   customer.subscription.deleted  … 解約 → 施設を停止
//   invoice.payment_failed         … 支払失敗 → past_due
//   invoice.payment_succeeded/paid … 支払成功 → active
// 疑似モード(署名検証なし)でもJSONを解釈して同じ処理を行える。

const { pool } = require('../db');
const payments = require('../services/payments');
const { completeSignup } = require('../services/signup');
const { writeLog } = require('../services/log');

// stripe price id からプラン(code)を引く
async function planByPriceId(priceId) {
  if (!priceId) return null;
  const r = await pool.query('SELECT code FROM plans WHERE stripe_price_id = $1', [priceId]);
  return r.rowCount ? r.rows[0].code : null;
}

// サブスク情報を施設へ同期(プラン・状態・期末)
async function syncSubscriptionToFacility(sub, statusOverride) {
  const subId = sub.id;
  const customerId = sub.customer;
  const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
  const planCode = await planByPriceId(priceId);
  const status = statusOverride || (sub.status === 'active' || sub.status === 'trialing' ? 'active'
    : sub.status === 'past_due' || sub.status === 'unpaid' ? 'past_due'
    : sub.status === 'canceled' ? 'canceled' : 'active');
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

  // 対象施設: subscription_id か customer_id で特定
  const f = await pool.query(
    `SELECT id FROM facilities WHERE stripe_subscription_id = $1 OR stripe_customer_id = $2 LIMIT 1`,
    [subId, customerId]
  );
  if (f.rowCount === 0) return null;
  const facilityId = f.rows[0].id;

  const sets = ['stripe_subscription_id = $2', 'stripe_customer_id = COALESCE($3, stripe_customer_id)', 'billing_status = $4', 'current_period_end = $5'];
  const params = [facilityId, subId, customerId, status, periodEnd];
  // プランは判別できたときだけ更新。解約時は据え置き(停止で制御)。
  if (planCode && status !== 'canceled') { params.push(planCode); sets.push(`plan_code = $${params.length}`); }
  // 有効/停止と猶予起点:
  //   active   → 有効化・猶予クリア
  //   canceled → 停止
  //   past_due → is_active は据え置き(猶予超過の自動停止はenforcePastDueで制御)。起点を記録
  if (status === 'active') {
    sets.push('is_active = TRUE', 'past_due_since = NULL');
  } else if (status === 'canceled') {
    sets.push('is_active = FALSE');
  } else if (status === 'past_due') {
    sets.push('past_due_since = COALESCE(past_due_since, now())');
  }

  await pool.query(`UPDATE facilities SET ${sets.join(', ')} WHERE id = $1`, params);
  await writeLog(pool, { userId: null, targetTable: 'facilities', targetId: facilityId, operationType: '更新',
    after: { billing_status: status, plan: planCode || undefined, subscription: subId }, facilityId });
  return facilityId;
}

async function handleWebhook(req, res) {
  const provider = payments.get(req.params.provider || 'stripe');
  if (!provider) return res.status(404).send('unknown provider');
  let event;
  try {
    event = provider.constructEvent(req.body, req.headers);
  } catch (err) {
    console.error(`[webhook:${provider.key}] 署名検証失敗:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const md = s.metadata || {};
        if (md.signupRequestId) {
          // 新規申込 → 施設＋管理者を自動作成
          await completeSignup(Number(md.signupRequestId), {
            customerId: s.customer, subscriptionId: s.subscription, status: 'active',
          }, { req });
        } else if (md.facilityId) {
          // 既存施設の無料→有料アップグレード → 施設にサブスクを紐付け
          const sets = ['stripe_customer_id = $2', 'stripe_subscription_id = $3', "billing_status = 'active'"];
          const params = [Number(md.facilityId), s.customer, s.subscription];
          if (md.planCode) { params.push(md.planCode); sets.push(`plan_code = $${params.length}`); }
          await pool.query(`UPDATE facilities SET ${sets.join(', ')} WHERE id = $1`, params);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        await syncSubscriptionToFacility(event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        await syncSubscriptionToFacility(event.data.object, 'canceled');
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        if (inv.subscription) {
          // past_due にし、猶予起点(past_due_since)を初回のみ記録
          await pool.query(
            `UPDATE facilities SET billing_status = 'past_due', past_due_since = COALESCE(past_due_since, now())
              WHERE stripe_subscription_id = $1`, [inv.subscription]);
        }
        break;
      }
      case 'invoice.payment_succeeded':
      case 'invoice.paid': {
        const inv = event.data.object;
        if (inv.subscription) {
          // 支払成功で復帰(停止解除・猶予起点クリア)
          await pool.query(
            `UPDATE facilities SET billing_status = 'active', is_active = TRUE, past_due_since = NULL
              WHERE stripe_subscription_id = $1`, [inv.subscription]);
        }
        break;
      }
      default:
        break; // 未対応イベントは無視
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] Webhook処理エラー:', event && event.type, err.message);
    // Stripeに再送を促すため500(冪等処理のため再送も安全)
    res.status(500).json({ error: 'internal' });
  }
}

module.exports = { handleWebhook, syncSubscriptionToFacility };
