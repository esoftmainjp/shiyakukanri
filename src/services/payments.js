'use strict';

// 決済プロバイダのレジストリ。画面(全体管理者)から有効プロバイダを切り替えられる。
//   ・アダプタは共通インターフェース(下記)を実装する。
//   ・有効プロバイダは system_settings.payment_provider で選択(未設定は環境変数/自動判定)。
//
// アダプタIF: {
//   key, label, implemented, supportsPortal, supportsProration,
//   isConfigured(),
//   async createSubscriptionCheckout({email, plan, successUrl, cancelUrl, metadata}) -> {url}|{mock:true},
//   constructEvent(rawBody, headers) -> event{type, data:{object}},
//   async updateSubscriptionPlan(subscriptionId, plan),
//   async cancelSubscription(subscriptionId),
//   async createBillingPortal(customerId, returnUrl) -> {url}|{mock:true},
// }

const { pool } = require('../db');

const adapters = {
  stripe: require('./payments-stripe'),
  payjp: require('./payments-payjp'),
  gmo: require('./payments-gmo'),
  mock: require('./payments-mock'),
};

async function getSetting(key) {
  try {
    const r = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    return r.rowCount ? r.rows[0].value : null;
  } catch (e) { return null; }
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}

// 有効プロバイダのキー。選択が無ければ 環境変数 → 自動判定(stripe設定済なら stripe、無ければ mock)。
async function activeKey() {
  const s = await getSetting('payment_provider');
  if (s && adapters[s]) return s;
  if (process.env.PAYMENT_PROVIDER && adapters[process.env.PAYMENT_PROVIDER]) return process.env.PAYMENT_PROVIDER;
  return adapters.stripe.isConfigured() ? 'stripe' : 'mock';
}
async function active() {
  return adapters[await activeKey()] || adapters.mock;
}
function get(key) { return adapters[key] || null; }

// 画面表示用: 各プロバイダの状態一覧
function list() {
  return Object.values(adapters).map((a) => ({
    key: a.key, label: a.label, implemented: !!a.implemented,
    configured: a.isConfigured(), supportsPortal: !!a.supportsPortal, supportsProration: !!a.supportsProration,
  }));
}
async function setActive(key) {
  if (!adapters[key]) { const e = new Error('不明な決済プロバイダです'); e.status = 400; throw e; }
  if (!adapters[key].implemented) { const e = new Error(`${adapters[key].label} は未実装のため選択できません`); e.status = 400; throw e; }
  await setSetting('payment_provider', key);
}

module.exports = { adapters, getSetting, setSetting, activeKey, active, get, list, setActive };
