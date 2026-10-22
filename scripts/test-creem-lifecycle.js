const assert = require('node:assert/strict');
const {
  hasSubscriptionAccess,
  normalizeCreemEvent,
} = require('../api/_creem');

const paid = normalizeCreemEvent({
  id: 'evt_paid',
  eventType: 'subscription.paid',
  created_at: 1792660000000,
  object: {
    id: 'sub_reviewlens',
    status: 'active',
    product: { id: 'prod_reviewlens' },
    customer: { id: 'cust_1', email: 'owner@example.com' },
    current_period_start_date: '2026-10-23T00:00:00.000Z',
    current_period_end_date: '2026-11-23T00:00:00.000Z',
  },
});
assert.equal(paid.subscriptionId, 'sub_reviewlens');
assert.equal(paid.status, 'active');
assert.equal(paid.productId, 'prod_reviewlens');
assert.equal(hasSubscriptionAccess({ status: paid.status }), true);

const canceled = normalizeCreemEvent({
  eventType: 'subscription.canceled',
  object: {
    id: 'sub_reviewlens',
    current_period_end_date: '2026-11-23T00:00:00.000Z',
    canceled_at: '2026-10-23T12:00:00.000Z',
  },
});
assert.equal(canceled.status, 'canceled');
assert.equal(canceled.accessUntil.toISOString(), '1970-01-01T00:00:00.000Z');
assert.equal(
  hasSubscriptionAccess(
    { status: canceled.status, access_until: canceled.accessUntil },
    new Date('2026-10-24T00:00:00.000Z')
  ),
  false
);

for (const eventType of [
  'subscription.paused',
  'subscription.unpaid',
  'subscription.past_due',
  'refund.created',
  'dispute.created',
]) {
  const normalized = normalizeCreemEvent({
    eventType,
    object: {
      id: `${eventType}-object`,
      subscription: { id: 'sub_reviewlens' },
    },
  });
  assert.equal(
    hasSubscriptionAccess({
      status: normalized.status,
      access_until: normalized.accessUntil,
    }),
    false,
    `${eventType} should revoke access`
  );
}

const checkout = normalizeCreemEvent({
  eventType: 'checkout.completed',
  object: {
    id: 'ch_1',
    request_id: 'reviewlens-pro-user-1',
    subscription: { id: 'sub_reviewlens' },
    product: { id: 'prod_reviewlens' },
    customer: { id: 'cust_1', email: 'owner@example.com' },
  },
});
assert.equal(checkout.checkoutId, 'ch_1');
assert.equal(checkout.subscriptionId, 'sub_reviewlens');
assert.equal(checkout.requestId, 'reviewlens-pro-user-1');

const scheduledCancel = normalizeCreemEvent({
  eventType: 'subscription.update',
  object: {
    id: 'sub_reviewlens',
    status: 'scheduled_cancel',
    current_period_end_date: '2026-11-23T00:00:00.000Z',
  },
});
assert.equal(scheduledCancel.status, 'scheduled_cancel');
assert.equal(
  hasSubscriptionAccess(
    { status: scheduledCancel.status, access_until: scheduledCancel.accessUntil },
    new Date('2026-11-01T00:00:00.000Z')
  ),
  true
);

assert.equal(
  normalizeCreemEvent({
    eventType: 'subscription.update',
    object: { id: 'sub_reviewlens' },
  }).status,
  null
);

console.log('Creem lifecycle normalization and access tests passed.');
