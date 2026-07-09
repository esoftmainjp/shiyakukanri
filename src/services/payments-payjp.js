'use strict';

// PAY.JP アダプタ枠(未実装スタブ)。契約・API仕様入手後に実装する。
// PAYJP_SECRET_KEY が設定されていれば「設定済み」と表示するが、処理は未実装。
function isConfigured() { return !!process.env.PAYJP_SECRET_KEY; }
function notImplemented() { const e = new Error('PAY.JP連携は未実装です（アダプタ実装待ち）'); e.status = 501; throw e; }

async function createSubscriptionCheckout() { notImplemented(); }
function constructEvent() { notImplemented(); }
async function updateSubscriptionPlan() { notImplemented(); }
async function cancelSubscription() { notImplemented(); }
async function createBillingPortal() { notImplemented(); }

module.exports = {
  key: 'payjp', label: 'PAY.JP', implemented: false, supportsPortal: false, supportsProration: false,
  isConfigured, createSubscriptionCheckout, constructEvent, updateSubscriptionPlan, cancelSubscription, createBillingPortal,
};
