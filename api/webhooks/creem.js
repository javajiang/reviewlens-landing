const crypto = require('crypto');
const { getPool, ensureSchema } = require('../_db');
const { normalizeCreemEvent } = require('../_creem');

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (!aBuf.length || aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function inferPlan(productId) {
  if (!productId) return null;
  if (process.env.CREEM_BASIC_PRODUCT_ID && productId === process.env.CREEM_BASIC_PRODUCT_ID) {
    return 'basic';
  }
  if (process.env.CREEM_PRO_PRODUCT_ID && productId === process.env.CREEM_PRO_PRODUCT_ID) {
    return 'pro';
  }
  return null;
}

async function findCheckoutSession(client, normalized) {
  if (!normalized.checkoutId && !normalized.requestId) return null;
  const result = await client.query(
    `
      SELECT request_id, shop_domain, user_id, plan, product_id, checkout_id
      FROM checkout_sessions
      WHERE ($1::text IS NOT NULL AND checkout_id = $1)
         OR ($2::text IS NOT NULL AND request_id = $2)
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [normalized.checkoutId, normalized.requestId]
  );
  return result.rows[0] || null;
}

async function findExistingSubscription(client, normalized) {
  const result = await client.query(
    `
      SELECT *
      FROM subscriptions
      WHERE ($1::text IS NOT NULL AND creem_subscription_id = $1)
         OR ($2::text IS NOT NULL AND checkout_id = $2)
         OR (
           $3::text IS NOT NULL
           AND customer_id = $3
           AND ($4::text IS NULL OR product_id = $4)
         )
         OR (
           $5::text IS NOT NULL
           AND LOWER(customer_email) = LOWER($5)
           AND ($4::text IS NULL OR product_id = $4)
         )
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [
      normalized.subscriptionId,
      normalized.checkoutId,
      normalized.customerId,
      normalized.productId,
      normalized.customerEmail,
    ]
  );
  return result.rows[0] || null;
}

function buildDedupeKey(normalized, checkoutSession, existing, productId, plan) {
  if (existing?.dedupe_key) return existing.dedupe_key;
  if (normalized.subscriptionId) return `subscription:${normalized.subscriptionId}`;
  if (checkoutSession?.user_id) {
    return `${checkoutSession.user_id}:${productId || plan || 'unknown'}`;
  }
  if (normalized.customerEmail) {
    return `${normalized.customerEmail.toLowerCase()}:${productId || plan || 'unknown'}`;
  }
  return `checkout:${normalized.checkoutId || normalized.requestId}`;
}

async function upsertSubscription(client, event, normalized, sourceEventId) {
  if (!normalized.status) return;

  const checkoutSession = await findCheckoutSession(client, normalized);
  const existing = await findExistingSubscription(client, normalized);
  const productId = normalized.productId || checkoutSession?.product_id || existing?.product_id || null;
  const plan = inferPlan(productId) || checkoutSession?.plan || existing?.plan || null;
  const dedupeKey = buildDedupeKey(
    normalized,
    checkoutSession,
    existing,
    productId,
    plan
  );
  const userId = checkoutSession?.user_id || existing?.user_id || normalized.userId || null;
  const shopDomain = checkoutSession?.shop_domain || existing?.shop_domain || normalized.shopDomain || null;
  const requestId = checkoutSession?.request_id || normalized.requestId || existing?.request_id || null;
  const checkoutId = normalized.checkoutId || checkoutSession?.checkout_id || existing?.checkout_id || null;
  const subscriptionId = normalized.subscriptionId || existing?.creem_subscription_id || null;

  if (normalized.eventType === 'checkout.completed' && plan === 'pro' && !subscriptionId) {
    throw new Error('ReviewLens Pro checkout did not create a recurring subscription.');
  }

  if (!userId && !existing) {
    throw new Error(`Unable to link ${normalized.eventType} to a ReviewLens user.`);
  }

  await client.query(
    `
      INSERT INTO subscriptions (
        dedupe_key, shop_domain, user_id, request_id, customer_email, customer_id,
        product_id, plan, status, checkout_id, creem_subscription_id,
        current_period_start, current_period_end, next_payment_at, canceled_at,
        access_until, last_event_created_at, source_event_id, raw_event
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        shop_domain = COALESCE(EXCLUDED.shop_domain, subscriptions.shop_domain),
        user_id = COALESCE(EXCLUDED.user_id, subscriptions.user_id),
        request_id = COALESCE(EXCLUDED.request_id, subscriptions.request_id),
        customer_email = COALESCE(EXCLUDED.customer_email, subscriptions.customer_email),
        customer_id = COALESCE(EXCLUDED.customer_id, subscriptions.customer_id),
        product_id = COALESCE(EXCLUDED.product_id, subscriptions.product_id),
        plan = COALESCE(EXCLUDED.plan, subscriptions.plan),
        status = EXCLUDED.status,
        checkout_id = COALESCE(EXCLUDED.checkout_id, subscriptions.checkout_id),
        creem_subscription_id = COALESCE(
          EXCLUDED.creem_subscription_id,
          subscriptions.creem_subscription_id
        ),
        current_period_start = COALESCE(
          EXCLUDED.current_period_start,
          subscriptions.current_period_start
        ),
        current_period_end = COALESCE(
          EXCLUDED.current_period_end,
          subscriptions.current_period_end
        ),
        next_payment_at = COALESCE(EXCLUDED.next_payment_at, subscriptions.next_payment_at),
        canceled_at = CASE
          WHEN EXCLUDED.status IN ('active', 'trialing') THEN NULL
          ELSE COALESCE(EXCLUDED.canceled_at, subscriptions.canceled_at)
        END,
        access_until = CASE
          WHEN EXCLUDED.status IN ('active', 'trialing') THEN NULL
          ELSE COALESCE(EXCLUDED.access_until, subscriptions.access_until)
        END,
        last_event_created_at = EXCLUDED.last_event_created_at,
        source_event_id = EXCLUDED.source_event_id,
        raw_event = EXCLUDED.raw_event,
        updated_at = NOW()
      WHERE subscriptions.last_event_created_at IS NULL
         OR EXCLUDED.last_event_created_at >= subscriptions.last_event_created_at
    `,
    [
      dedupeKey,
      shopDomain,
      userId,
      requestId,
      normalized.customerEmail || existing?.customer_email || null,
      normalized.customerId || existing?.customer_id || null,
      productId,
      plan,
      normalized.status,
      checkoutId,
      subscriptionId,
      normalized.currentPeriodStart,
      normalized.currentPeriodEnd,
      normalized.nextPaymentAt,
      normalized.canceledAt,
      normalized.accessUntil,
      normalized.eventCreatedAt,
      sourceEventId,
      event,
    ]
  );

  if (checkoutSession) {
    await client.query(
      `
        UPDATE checkout_sessions
        SET status = $2, updated_at = NOW()
        WHERE request_id = $1
      `,
      [checkoutSession.request_id, normalized.status]
    );
  }
}

async function processEvent(event, rawBody) {
  const normalized = normalizeCreemEvent(event);
  if (!normalized.eventType) throw new Error('Missing Creem event type.');

  const sourceEventId = String(
    event.id || crypto.createHash('sha256').update(rawBody).digest('hex')
  );
  const plan = inferPlan(normalized.productId);

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO creem_webhook_events (
          event_id, event_type, checkout_id, subscription_id, customer_id,
          customer_email, product_id, plan, status, raw_event
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (event_id) DO UPDATE SET
          event_type = EXCLUDED.event_type,
          checkout_id = EXCLUDED.checkout_id,
          subscription_id = EXCLUDED.subscription_id,
          customer_id = EXCLUDED.customer_id,
          customer_email = EXCLUDED.customer_email,
          product_id = EXCLUDED.product_id,
          plan = COALESCE(EXCLUDED.plan, creem_webhook_events.plan),
          status = EXCLUDED.status,
          raw_event = EXCLUDED.raw_event,
          processed_at = NOW()
      `,
      [
        sourceEventId,
        normalized.eventType,
        normalized.checkoutId,
        normalized.subscriptionId,
        normalized.customerId,
        normalized.customerEmail,
        normalized.productId,
        plan,
        normalized.status || 'received',
        event,
      ]
    );

    await upsertSubscription(client, event, normalized, sourceEventId);
    await client.query('COMMIT');
    return normalized;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const secret = process.env.CREEM_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).json({ ok: false, error: 'CREEM_WEBHOOK_SECRET is not set' });
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = String(req.headers['creem-signature'] || '');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signature || !timingSafeEqual(signature, expected)) {
      res.status(400).json({ ok: false, error: 'Invalid webhook signature' });
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
      return;
    }

    const normalized = await processEvent(event, rawBody);
    res.status(200).json({
      ok: true,
      eventType: normalized.eventType,
      status: normalized.status || 'recorded',
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

module.exports = handler;
module.exports.processEvent = processEvent;
