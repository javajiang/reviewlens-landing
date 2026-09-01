const crypto = require('crypto');
const { getPool, ensureSchema } = require('../_db');

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
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

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
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

module.exports = async (req, res) => {
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
    const signature = String(req.headers['creem-signature'] || req.headers['x-creem-signature'] || '');

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

    const eventType = String(event.eventType || event.type || '').toLowerCase();
    const eventObject = event.object || {};
    const checkoutId = pickFirst(
      eventObject.checkout_id,
      eventObject.checkoutId,
      eventObject.id,
      eventObject.checkout?.id
    );
    const customerId = pickFirst(
      eventObject.customer_id,
      eventObject.customerId,
      eventObject.customer?.id,
      eventObject.customer
    );
    const customerEmail = pickFirst(
      eventObject.customer_email,
      eventObject.customerEmail,
      eventObject.email,
      eventObject.customer?.email
    );
    const productId = pickFirst(
      eventObject.product_id,
      eventObject.productId,
      eventObject.product?.id,
      eventObject.items?.[0]?.product_id,
      eventObject.items?.[0]?.productId
    );
    const plan = inferPlan(productId);
    const status = eventType === 'checkout.completed'
      ? 'active'
      : eventType.includes('refund')
        ? 'refunded'
        : eventType.includes('cancel')
          ? 'canceled'
          : 'received';
    const sourceEventId = String(event.id || crypto.createHash('sha256').update(rawBody).digest('hex'));
    const dedupeKey = customerEmail
      ? `${customerEmail.toLowerCase()}:${productId || plan || 'unknown'}`
      : `${checkoutId || sourceEventId}`;

    await ensureSchema();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `
          INSERT INTO creem_webhook_events (
            event_id, event_type, checkout_id, customer_id, customer_email, product_id, plan, status, raw_event
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (event_id) DO UPDATE SET
            event_type = EXCLUDED.event_type,
            checkout_id = EXCLUDED.checkout_id,
            customer_id = EXCLUDED.customer_id,
            customer_email = EXCLUDED.customer_email,
            product_id = EXCLUDED.product_id,
            plan = EXCLUDED.plan,
            status = EXCLUDED.status,
            raw_event = EXCLUDED.raw_event,
            processed_at = NOW()
        `,
        [sourceEventId, eventType || 'unknown', checkoutId, customerId, customerEmail, productId, plan, status, event]
      );

      if (eventType === 'checkout.completed') {
        await client.query(
          `
            INSERT INTO subscriptions (
              dedupe_key, customer_email, customer_id, product_id, plan, status, checkout_id, source_event_id, raw_event
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (dedupe_key) DO UPDATE SET
              customer_email = COALESCE(EXCLUDED.customer_email, subscriptions.customer_email),
              customer_id = COALESCE(EXCLUDED.customer_id, subscriptions.customer_id),
              product_id = COALESCE(EXCLUDED.product_id, subscriptions.product_id),
              plan = COALESCE(EXCLUDED.plan, subscriptions.plan),
              status = EXCLUDED.status,
              checkout_id = COALESCE(EXCLUDED.checkout_id, subscriptions.checkout_id),
              source_event_id = EXCLUDED.source_event_id,
              raw_event = EXCLUDED.raw_event,
              updated_at = NOW()
          `,
          [dedupeKey, customerEmail, customerId, productId, plan, 'active', checkoutId, sourceEventId, event]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
