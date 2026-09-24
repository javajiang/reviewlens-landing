const { ensureSchema, getPool } = require('../_db');
const { ensureShopifySchema, normalizeShopDomain } = require('../_shopify');

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const shop = normalizeShopDomain(req.query.shop || req.query.shopDomain);
    if (!shop || !isValidShop(shop)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing shop parameter' });
      return;
    }

    await ensureShopifySchema();
    await ensureSchema();
    const client = await getPool().connect();
    try {
      const installation = await client.query(
        'SELECT shop_domain FROM shopify_installations WHERE shop_domain = $1 LIMIT 1',
        [shop]
      );
      if (!installation.rows[0]) {
        res.status(200).json({ ok: true, authorized: false, paid: false, plan: null });
        return;
      }

      const result = await client.query(
        `
          SELECT plan, status, updated_at
          FROM subscriptions
          WHERE shop_domain = $1
            AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [shop]
      );
      const subscription = result.rows[0] || null;
      res.status(200).json({
        ok: true,
        authorized: true,
        paid: Boolean(subscription),
        plan: subscription?.plan || null,
        updatedAt: subscription?.updated_at || null,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
