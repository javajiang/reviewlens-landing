const {
  MAX_REVIEWS,
  ensureShopifySchema,
  getAuthorizedInstallation,
  getPool,
  handleFromUrl,
  isValidShop,
  normalizeHandle,
  normalizeReviews,
  normalizeShopDomain,
} = require('./_shared');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const shop = normalizeShopDomain(body.shopDomain || body.shop || body.shop_domain);
    const product = body.product && typeof body.product === 'object' ? body.product : {};
    const productUrl = String(product.url || body.productUrl || '').trim();
    const handle = normalizeHandle(product.handle || body.productHandle) || normalizeHandle(handleFromUrl(productUrl));
    const reviews = normalizeReviews(body.reviews);
    const source = String(body.source || reviews[0]?.source || '').trim() || null;

    if (!shop || !isValidShop(shop)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing shop domain' });
      return;
    }
    if (!handle) {
      res.status(400).json({ ok: false, error: 'Invalid or missing product handle' });
      return;
    }
    if (!Array.isArray(body.reviews)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing reviews array' });
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

      const canonicalUrl = productUrl || `https://${shop}/products/${handle}`;
      const productTitle = String(product.title || body.productTitle || '').trim() || null;
      const productDescription = String(product.description || body.productDescription || '').trim() || null;

      const result = await client.query(
        `
          INSERT INTO review_data (
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
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'completed', NOW(), NOW())
          ON CONFLICT (shop_domain, product_handle) DO UPDATE SET
            product_url = EXCLUDED.product_url,
            product_title = EXCLUDED.product_title,
            product_description = EXCLUDED.product_description,
            reviews = EXCLUDED.reviews,
            review_count = EXCLUDED.review_count,
            source = EXCLUDED.source,
            scrape_status = EXCLUDED.scrape_status,
            scraped_at = EXCLUDED.scraped_at,
            updated_at = NOW()
          RETURNING id, scraped_at, updated_at
        `,
        [
          shop,
          handle,
          canonicalUrl,
          productTitle,
          productDescription,
          JSON.stringify(reviews),
          reviews.length,
          source,
        ]
      );

      await client.query(
        `
          UPDATE shopify_installations
          SET
            current_product_url = $2,
            current_product_handle = $3,
            current_product_title = COALESCE($4, current_product_title),
            current_product_description = COALESCE($5, current_product_description),
            current_review_count = $6,
            current_target_updated_at = NOW(),
            updated_at = NOW()
          WHERE shop_domain = $1
        `,
        [shop, canonicalUrl, handle, productTitle, productDescription, reviews.length]
      );

      const row = result.rows[0];
      res.status(200).json({
        ok: true,
        authorized: true,
        id: row.id,
        shopDomain: shop,
        productHandle: handle,
        received: Array.isArray(body.reviews) ? body.reviews.length : 0,
        saved: reviews.length,
        maxReviews: MAX_REVIEWS,
        source,
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
