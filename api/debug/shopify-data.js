const { getPool } = require('../../_db');
const { ensureShopifySchema, normalizeShopDomain } = require('../../_shopify');

function unauthorized(res) {
  res.status(403).json({ ok: false, error: 'Forbidden' });
}

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

module.exports = async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const expected = String(process.env.DEBUG_TOKEN || '');

    if (!expected || token !== expected) {
      unauthorized(res);
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
      const [installationResult, productResult] = await Promise.all([
        client.query(
          `
            SELECT
              shop_domain,
              scope,
              current_product_url,
              current_product_handle,
              current_product_title,
              current_product_description,
              current_review_count,
              current_analysis_status,
              current_target_updated_at,
              installed_at,
              updated_at
            FROM shopify_installations
            WHERE shop_domain = $1
            LIMIT 1
          `,
          [shop]
        ),
        client.query(
          `
            SELECT
              shop_domain,
              product_handle,
              product_url,
              product_title,
              product_description,
              last_review_count,
              last_scraped_at,
              created_at,
              updated_at
            FROM shopify_products
            WHERE shop_domain = $1
            ORDER BY updated_at DESC
            LIMIT 20
          `,
          [shop]
        ),
      ]);

      res.status(200).json({
        ok: true,
        shop,
        installation: installationResult.rows[0] || null,
        products: productResult.rows,
        hasInstallation: Boolean(installationResult.rows[0]),
        productCount: productResult.rows.length,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
