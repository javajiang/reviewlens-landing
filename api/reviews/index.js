const {
  ensureShopifySchema,
  getAuthorizedInstallation,
  getPool,
  handleFromUrl,
  isValidShop,
  normalizeHandle,
  normalizeShopDomain,
} = require('./_shared');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const shop = normalizeShopDomain(req.query.shop || req.query.shopDomain);
    const productUrl = String(req.query.url || '').trim();
    const handle = normalizeHandle(req.query.handle) || normalizeHandle(handleFromUrl(productUrl));

    if (!shop || !isValidShop(shop)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing shop parameter' });
      return;
    }
    if (!handle) {
      res.status(400).json({ ok: false, error: 'Invalid or missing product handle' });
      return;
    }

    await ensureShopifySchema();
    const client = await getPool().connect();
    try {
      const installation = await getAuthorizedInstallation(client, shop);
      if (!installation) {
        res.status(403).json({ ok: false, authorized: false, error: 'Shop is not authorized' });
        return;
      }

      const result = await client.query(
        `
          SELECT
            id,
            shop_domain,
            product_handle,
            product_url,
            product_title,
            product_description,
            reviews,
            review_count,
            source,
            scrape_status,
            scraped_at,
            updated_at
          FROM review_data
          WHERE shop_domain = $1
            AND product_handle = $2
          LIMIT 1
        `,
        [shop, handle]
      );
      const row = result.rows[0] || null;

      if (!row) {
        res.status(404).json({
          ok: false,
          authorized: true,
          error: 'No saved reviews found for this product',
        });
        return;
      }

      res.status(200).json({
        ok: true,
        authorized: true,
        id: row.id,
        shopDomain: row.shop_domain,
        productHandle: row.product_handle,
        productUrl: row.product_url,
        productTitle: row.product_title,
        productDescription: row.product_description,
        reviews: Array.isArray(row.reviews) ? row.reviews : [],
        reviewCount: row.review_count,
        source: row.source,
        scrapeStatus: row.scrape_status,
        scrapedAt: row.scraped_at,
        updatedAt: row.updated_at,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
