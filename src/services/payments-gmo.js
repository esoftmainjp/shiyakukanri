'use strict';

// GMO-PG(PGマルチペイメント) アダプタ枠(未実装スタブ)。契約・仕様書入手後に実装する。
function isConfigured() { return !!(process.env.GMO_SHOP_ID && process.env.GMO_SHOP_PASS); }
function notImplemented() { const e = new Error('GMO-PG連携は未実装です（アダプタ実装待ち）'); e.status = 501; throw e; }

async function createSubscriptionCheckout() { notImplemented(); }
function constructEvent() { notImplemented(); }
async function updateSubscriptionPlan() { notImplemented(); }
async function cancelSubscription() { notImplemented(); }
async function createBillingPortal() { notImplemented(); }

module.exports = {
  key: 'gmo', label: 'GMO-PG', implemented: false, supportsPortal: false, supportsProration: false,
  isConfigured, createSubscriptionCheckout, constructEvent, updateSubscriptionPlan, cancelSubscription, createBillingPortal,
};
