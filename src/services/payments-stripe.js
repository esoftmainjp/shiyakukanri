'use strict';

// Stripe 決済アダプタ(実装)。STRIPE_SECRET_KEY 設定時に有効。
let _stripe = null;
function isConfigured() { return !!process.env.STRIPE_SECRET_KEY; }
function getStripe() {
  if (!isConfigured()) return null;
  if (!_stripe) {
    const Stripe = require('stripe');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return _stripe;
}

async function createSubscriptionCheckout({ email, plan, successUrl, cancelUrl, metadata = {} }) {
  if (!plan || !plan.stripe_price_id) { const e = new Error('このプランのStripe価格ID(stripe_price_id)が未設定です'); e.status = 500; throw e; }
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true,
  });
  return { url: session.url, sessionId: session.id };
}

// Webhookイベントを検証して返す(署名鍵未設定時は検証なしでJSON解釈)。
function constructEvent(rawBody, headers) {
  const sig = headers['stripe-signature'];
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
  }
  return getStripe().webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
}

async function updateSubscriptionPlan(subscriptionId, plan) {
  if (!plan || !plan.stripe_price_id) { const e = new Error('このプランのStripe価格IDが未設定です'); e.status = 500; throw e; }
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const itemId = sub.items.data[0].id;
  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: plan.stripe_price_id }],
    proration_behavior: 'create_prorations',
  });
}

async function cancelSubscription(subscriptionId) {
  return getStripe().subscriptions.cancel(subscriptionId);
}

async function createBillingPortal(customerId, returnUrl) {
  const s = await getStripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return { url: s.url };
}

module.exports = {
  key: 'stripe', label: 'Stripe', implemented: true, supportsPortal: true, supportsProration: true,
  isConfigured, getStripe, createSubscriptionCheckout, constructEvent, updateSubscriptionPlan, cancelSubscription, createBillingPortal,
};
