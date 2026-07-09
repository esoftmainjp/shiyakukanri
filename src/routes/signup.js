'use strict';

// LPからのセルフ利用登録(公開・要ログインなし)。
//   POST /api/signup                申込。無料は即施設作成、有料はStripe Checkoutへ。
//   GET  /api/signup/plans          申込可能なプラン一覧(料金つき)
//   GET  /api/signup/verify-token   パスワード設定リンクの有効性確認
//   POST /api/signup/set-password   トークンでパスワード設定
//   POST /api/signup/dev-complete   疑似決済の完了(Stripe未設定・本番以外のみ)
// Webhook(POST /api/stripe/webhook)は server.js で raw body 付きでマウントする。

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { isEmail } = require('../services/validate');
const payments = require('../services/payments');
const { completeSignup, resendSetupLink, verifySetupToken, setPasswordByToken, appBaseUrl } = require('../services/signup');
const { facilityNameTaken } = require('../services/facility');

const router = express.Router();
const isProd = process.env.NODE_ENV === 'production';

const signupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: Number(process.env.SIGNUP_RATE_MAX) || 10, standardHeaders: true, legacyHeaders: false,
  message: { error: '申込が多すぎます。しばらくしてから再度お試しください。' },
});

// 申込可能プラン(料金・上限・主な機能)
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT code, name, price, max_users, max_products, log_retention_days,
              feat_stocktake, feat_barcode, feat_reports, feat_ledger, feat_import, feat_billing
         FROM plans ORDER BY sort_order, price, code`
    );
    res.json({ plans: rows, paymentMode: (await payments.active()).key });
  } catch (err) {
    console.error('申込プラン取得エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 申込
router.post('/', signupLimiter, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // ハニーポット
  const facilityName = String(b.facilityName == null ? '' : b.facilityName).trim();
  const email = String(b.email == null ? '' : b.email).trim();
  const planCode = String(b.planCode == null ? '' : b.planCode).trim();
  if (!facilityName) return res.status(400).json({ error: '施設名称を入力してください' });
  if (!isEmail(email)) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  if (facilityName.length > 255) return res.status(400).json({ error: '施設名称が長すぎます' });

  try {
    const pl = await pool.query('SELECT code, price, stripe_price_id FROM plans WHERE code = $1', [planCode]);
    if (pl.rowCount === 0) return res.status(400).json({ error: 'プランを選択してください' });
    const plan = pl.rows[0];

    // 既存ログインID(メール)の扱い(resendSetupLinkの判定に一本化):
    //   未完了(パスワード未設定) → 重複施設を作らず、設定メールを再送(何度でも可)
    //   利用開始済み/別種で使用中 → 409(ログインへ誘導)
    const dup = await pool.query('SELECT 1 FROM users WHERE login_id = $1', [email]);
    if (dup.rowCount > 0) {
      const r = await resendSetupLink(email, { req });
      if (r.status === 'sent') {
        return res.json({ ok: true, mode: 'resent',
          message: 'このメールでの登録は手続き中です。パスワード設定メールを再送しました（迷惑メールもご確認ください）。',
          setPasswordUrl: isProd ? undefined : r.setUrl });
      }
      return res.status(409).json({ error: 'このメールアドレスは既に登録済みです。ログイン画面からご利用ください。', reason: 'already_registered' });
    }

    // 施設名の重複チェック(前後空白・大文字小文字を無視)
    if (await facilityNameTaken(pool, facilityName)) {
      return res.status(409).json({ error: 'この施設名は既に使用されています。別の施設名でご登録ください。', reason: 'facility_name_taken' });
    }

    // 申込保留を作成
    const sr = await pool.query(
      `INSERT INTO signup_requests (facility_name, email, plan_code, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [facilityName, email, plan.code]
    );
    const reqId = sr.rows[0].id;

    // 無料プラン: カード不要で即施設作成
    if (Number(plan.price) === 0) {
      const r = await completeSignup(reqId, {}, { req });
      return res.json({ ok: true, mode: 'free', message: 'アカウントを作成しました。パスワード設定メールをご確認ください。',
        setPasswordUrl: isProd ? undefined : r.setUrl });
    }

    // 有料プラン: 有効な決済プロバイダで処理
    const provider = await payments.active();

    // 疑似(mock)モード: フロントが dev-complete で完了させる(本番では不可)
    if (provider.key === 'mock') {
      if (isProd) {
        await pool.query("UPDATE signup_requests SET status = 'canceled' WHERE id = $1", [reqId]);
        return res.status(503).json({ error: '有料プランのオンライン申込は現在準備中です。お手数ですがお問い合わせください。' });
      }
      return res.json({ ok: true, mode: 'mock', signupRequestId: reqId, devCompleteUrl: `/api/signup/dev-complete` });
    }

    // 実プロバイダが未設定なら受け付けない
    if (!provider.isConfigured()) {
      await pool.query("UPDATE signup_requests SET status = 'canceled' WHERE id = $1", [reqId]);
      return res.status(503).json({ error: `選択中の決済プロバイダ（${provider.label}）が未設定です。決済設定をご確認ください。` });
    }

    const base = appBaseUrl(req);
    const session = await provider.createSubscriptionCheckout({
      email,
      plan,
      successUrl: `${base}/signup-complete.html?req=${reqId}`,
      cancelUrl: `${base}/signup.html?canceled=1`,
      metadata: { signupRequestId: String(reqId), planCode: plan.code },
    });
    await pool.query('UPDATE signup_requests SET stripe_session_id = $2 WHERE id = $1', [reqId, session.sessionId]);
    return res.json({ ok: true, mode: 'checkout', checkoutUrl: session.url });
  } catch (err) {
    console.error('申込エラー:', err.status || '', err.message);
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// 疑似決済の完了(Stripe未設定かつ本番以外のみ許可)。ローカル検証用。
router.post('/dev-complete', async (req, res) => {
  const provider = await payments.active();
  if (isProd || provider.key !== 'mock') return res.status(404).json({ error: 'not found' });
  const reqId = Number((req.body || {}).signupRequestId);
  if (!reqId) return res.status(400).json({ error: 'signupRequestId が必要です' });
  try {
    const r = await completeSignup(reqId, { customerId: 'sim_cus_' + reqId, subscriptionId: 'sim_sub_' + reqId, status: 'active' }, { req });
    res.json({ ok: true, alreadyDone: r.alreadyDone, setPasswordUrl: r.setUrl, email: r.email });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// パスワード設定メールの再送(未完了アカウントのみ・何度でも可)
router.post('/resend', signupLimiter, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // ハニーポット
  const email = String(b.email == null ? '' : b.email).trim();
  if (!isEmail(email)) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  try {
    const r = await resendSetupLink(email, { req });
    if (r.status === 'active') return res.status(409).json({ error: '既にご利用開始済みです。ログイン画面からご利用ください。', reason: 'already_registered' });
    if (r.status === 'notfound') return res.status(404).json({ error: 'このメールアドレスでの登録が見つかりません。メールアドレス（打ち間違いがないか）をご確認いただくか、最初から利用登録してください。', reason: 'not_found' });
    return res.json({ ok: true, message: 'パスワード設定メールを再送しました。迷惑メールもご確認ください。',
      setPasswordUrl: isProd ? undefined : r.setUrl });
  } catch (err) {
    console.error('再送エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// パスワード設定リンクの有効性確認(画面表示用)
router.get('/verify-token', async (req, res) => {
  try {
    const info = await verifySetupToken(String(req.query.token || ''));
    if (!info) return res.status(400).json({ ok: false, error: 'リンクが無効か有効期限切れです' });
    res.json({ ok: true, loginId: info.loginId });
  } catch (err) {
    console.error('トークン検証エラー:', err.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// トークンでパスワードを設定
router.post('/set-password', signupLimiter, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await setPasswordByToken(String(b.token || ''), String(b.password || ''));
    res.json({ ok: true, loginId: r.loginId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

module.exports = router;
