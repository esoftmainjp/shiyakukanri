'use strict';

// 疑似決済アダプタ(ローカル検証用)。実際の課金は発生しない。
// createSubscriptionCheckout は {mock:true} を返し、呼び出し側が dev-complete/dev-apply で完了させる。
function isConfigured() { return true; }

async function createSubscriptionCheckout() {
  return { mock: true, sessionId: 'sim_' + Math.floor(Math.random() * 1e9) };
}
function constructEvent(rawBody) {
  return typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
}
async function updateSubscriptionPlan() { return { mock: true }; }
async function cancelSubscription() { return { mock: true }; }
async function createBillingPortal() { return { mock: true }; }

module.exports = {
  key: 'mock', label: '疑似（ローカル検証）', implemented: true, supportsPortal: false, supportsProration: true,
  isConfigured, createSubscriptionCheckout, constructEvent, updateSubscriptionPlan, cancelSubscription, createBillingPortal,
};
