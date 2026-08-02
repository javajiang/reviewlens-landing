const { getPool, ensureSchema } = require('./_db');

function unauthorized(res) {
  res.status(403).json({ ok: false, error: 'Forbidden' });
}

module.exports = async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const expected = String(process.env.DEBUG_TOKEN || '');

    if (!expected || token !== expected) {
      unauthorized(res);
      return;
    }

    await ensureSchema();
    const client = await getPool().connect();
    try {
      const [events, subs, latestSub, latestEvent] = await Promise.all([
        client.query('select count(*)::int as count from creem_webhook_events'),
        client.query('select count(*)::int as count from subscriptions'),
        client.query(
          'select customer_email, customer_id, product_id, plan, status, checkout_id, updated_at from subscriptions order by updated_at desc limit 5'
        ),
        client.query(
          'select event_id, event_type, customer_email, product_id, plan, status, processed_at from creem_webhook_events order by processed_at desc limit 5'
        ),
      ]);

      res.status(200).json({
        ok: true,
        counts: {
          creem_webhook_events: events.rows[0].count,
          subscriptions: subs.rows[0].count,
        },
        latest: {
          subscriptions: latestSub.rows,
          creem_webhook_events: latestEvent.rows,
        },
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
