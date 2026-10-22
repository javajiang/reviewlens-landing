function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSubscriptionStatus(eventType, object) {
  switch (eventType) {
    case 'checkout.completed':
    case 'subscription.active':
    case 'subscription.paid':
      return 'active';
    case 'subscription.trialing':
      return 'trialing';
    case 'subscription.canceled':
      return 'canceled';
    case 'subscription.scheduled_cancel':
      return 'scheduled_cancel';
    case 'subscription.paused':
      return 'paused';
    case 'subscription.unpaid':
      return 'unpaid';
    case 'subscription.past_due':
      return 'past_due';
    case 'subscription.expired':
      return 'expired';
    case 'refund.created':
      return 'refunded';
    case 'dispute.created':
      return 'disputed';
    case 'subscription.update':
      return normalizeReportedStatus(object?.status);
    default:
      return null;
  }
}

function normalizeReportedStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).toLowerCase();
}

function normalizeCreemEvent(event) {
  const eventType = String(event?.eventType || event?.type || '').toLowerCase();
  const object = event?.object && typeof event.object === 'object' ? event.object : {};
  const isCheckout = eventType === 'checkout.completed';
  const isSubscription = eventType.startsWith('subscription.');
  const isReversal = eventType === 'refund.created' || eventType === 'dispute.created';

  const checkoutId = isCheckout
    ? pickFirst(object.id, object.checkout_id, object.checkoutId, object.checkout?.id)
    : pickFirst(object.checkout_id, object.checkoutId, object.checkout?.id);
  const subscriptionId = isCheckout
    ? pickFirst(
      object.subscription?.id,
      typeof object.subscription === 'string' ? object.subscription : null,
      object.subscription_id,
      object.subscriptionId
    )
    : isSubscription
      ? pickFirst(object.id, object.subscription_id, object.subscriptionId)
      : isReversal
        ? pickFirst(
          object.subscription?.id,
          typeof object.subscription === 'string' ? object.subscription : null,
          object.subscription_id,
          object.subscriptionId
        )
        : null;
  const customer = object.customer && typeof object.customer === 'object' ? object.customer : {};
  const product = object.product && typeof object.product === 'object' ? object.product : {};
  const productId = pickFirst(
    product.id,
    typeof object.product === 'string' ? object.product : null,
    object.product_id,
    object.productId,
    object.order?.product,
    object.items?.[0]?.product_id,
    object.items?.[0]?.productId
  );
  const currentPeriodEnd = parseTimestamp(
    pickFirst(
      object.current_period_end_date,
      object.currentPeriodEndDate,
      object.current_period_end,
      object.currentPeriodEnd
    )
  );
  const status = normalizeSubscriptionStatus(eventType, object);
  const immediateRevocation = [
    'canceled',
    'expired',
    'paused',
    'unpaid',
    'past_due',
    'refunded',
    'disputed',
  ].includes(status);

  return {
    eventType,
    object,
    checkoutId: checkoutId ? String(checkoutId) : null,
    subscriptionId: subscriptionId ? String(subscriptionId) : null,
    customerId: pickFirst(
      customer.id,
      object.customer_id,
      object.customerId,
      typeof object.customer === 'string' ? object.customer : null
    ),
    customerEmail: pickFirst(
      customer.email,
      object.customer_email,
      object.customerEmail,
      object.email
    ),
    productId: productId ? String(productId) : null,
    requestId: pickFirst(
      event?.request_id,
      event?.requestId,
      object.request_id,
      object.requestId,
      object.metadata?.request_id,
      object.metadata?.requestId
    ),
    userId: pickFirst(
      object.metadata?.user_id,
      object.metadata?.userId,
      object.metadata?.reference_id,
      object.metadata?.referenceId
    ),
    shopDomain: pickFirst(
      object.metadata?.shop_domain,
      object.metadata?.shopDomain
    ),
    status,
    currentPeriodStart: parseTimestamp(
      pickFirst(
        object.current_period_start_date,
        object.currentPeriodStartDate,
        object.current_period_start,
        object.currentPeriodStart
      )
    ),
    currentPeriodEnd,
    nextPaymentAt: parseTimestamp(
      pickFirst(object.next_transaction_date, object.nextTransactionDate)
    ),
    canceledAt: parseTimestamp(
      pickFirst(object.canceled_at, object.canceledAt)
    ),
    accessUntil: immediateRevocation ? new Date(0) : currentPeriodEnd,
    eventCreatedAt: parseTimestamp(
      pickFirst(event?.created_at, event?.createdAt)
    ) || new Date(),
  };
}

function hasSubscriptionAccess(subscription, now = new Date()) {
  if (!subscription) return false;
  const status = String(subscription.status || '').toLowerCase();
  if (status === 'active' || status === 'trialing') return true;
  if (status !== 'scheduled_cancel') return false;
  const accessUntil = parseTimestamp(subscription.access_until);
  return Boolean(accessUntil && accessUntil.getTime() > now.getTime());
}

module.exports = {
  hasSubscriptionAccess,
  normalizeCreemEvent,
  parseTimestamp,
  pickFirst,
};
