const { getPool } = require('../_db');
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

    const shop = normalizeShopDomain(req.query.shop);
    if (!shop || !isValidShop(shop)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing shop parameter' });
      return;
    }

    await ensureShopifySchema();
    const client = await getPool().connect();
    try {
      const result = await client.query(
        `
          SELECT
            shop_domain,
            scope,
            installed_at,
            updated_at,
            current_product_url,
            current_product_handle,
            current_product_title,
            current_product_description,
            current_review_count,
            current_analysis_status,
            current_target_updated_at
          FROM shopify_installations
          WHERE shop_domain = $1
          LIMIT 1
        `,
        [shop]
      );

      const installation = result.rows[0] || null;
      res.status(200).json({
        ok: true,
        authorized: Boolean(installation),
        installation,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
