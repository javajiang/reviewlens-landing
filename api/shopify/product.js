const crypto = require('crypto');
const { getPool } = require('../_db');
const { ensureShopifySchema, getShopifyAdminApiBaseUrl, normalizeShopDomain } = require('../_shopify');

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function normalizeHandle(handle) {
  return String(handle || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('?')[0]
    .split('#')[0];
}

function handleFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/products\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getInstallation(client, shop) {
  const result = await client.query(
    'SELECT access_token FROM shopify_installations WHERE shop_domain = $1 LIMIT 1',
    [shop]
  );
  return result.rows[0] || null;
}

async function fetchProductFromShopify({ shop, accessToken, handle }) {
  const response = await fetch(`${getShopifyAdminApiBaseUrl(shop)}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': accessToken,
    },
    body: JSON.stringify({
      query: `
        query ProductByHandle($handle: String!) {
          productByHandle(handle: $handle) {
            id
            handle
            title
            description
            descriptionHtml
            vendor
            productType
            onlineStoreUrl
            featuredImage {
              url
              altText
            }
          }
        }
      `,
      variables: { handle },
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Shopify product fetch failed: ${response.status}`);
  }
  if (data.errors?.length) {
    throw new Error(data.errors.map((item) => item.message).join('; '));
  }

  return {
    product: data.data?.productByHandle || null,
    responseStatus: response.status,
    responseOk: response.ok,
    responseErrors: data.errors || [],
    responseExtensions: data.extensions || null,
  };
}

async function upsertProduct(client, { shop, handle, productUrl, product }) {
  await client.query(
    `
      INSERT INTO shopify_products (
        shop_domain,
        product_handle,
        product_url,
        product_title,
        product_description,
        product_data,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      ON CONFLICT (shop_domain, product_handle) DO UPDATE SET
        product_url = EXCLUDED.product_url,
        product_title = EXCLUDED.product_title,
        product_description = EXCLUDED.product_description,
        product_data = EXCLUDED.product_data,
        updated_at = NOW()
    `,
    [
      shop,
      handle,
      productUrl,
      product?.title || null,
      product?.description || stripHtml(product?.descriptionHtml),
      JSON.stringify(product || {}),
    ]
  );

  await client.query(
    `
      UPDATE shopify_installations
      SET
        current_product_url = $2,
        current_product_handle = $3,
        current_product_title = $4,
        current_product_description = $5,
        current_target_updated_at = NOW(),
        updated_at = NOW()
      WHERE shop_domain = $1
    `,
    [
      shop,
      productUrl,
      handle,
      product?.title || null,
      product?.description || stripHtml(product?.descriptionHtml),
    ]
  );
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const shop = normalizeShopDomain(req.query.shop);
    const productUrl = String(req.query.url || '').trim();
    const debug = String(req.query.debug || '') === '1';
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
      const installation = await getInstallation(client, shop);
      if (!installation) {
        res.status(404).json({ ok: false, authorized: false, error: 'Shop is not authorized' });
        return;
      }

      const token = String(installation.access_token || '');
      const productResult = await fetchProductFromShopify({
        shop,
        accessToken: token,
        handle,
      });
      const product = productResult.product;

      if (!product) {
        res.status(404).json({ ok: false, authorized: true, error: 'Product not found' });
        return;
      }

      const canonicalUrl = product.onlineStoreUrl || productUrl || `https://${shop}/products/${handle}`;
      await upsertProduct(client, { shop, handle, productUrl: canonicalUrl, product });

      res.status(200).json({
        ok: true,
        authorized: true,
        product: {
          shopDomain: shop,
          handle: product.handle || handle,
          url: canonicalUrl,
          title: product.title || '',
          description: product.description || stripHtml(product.descriptionHtml),
          vendor: product.vendor || '',
          productType: product.productType || '',
          featuredImage: product.featuredImage || null,
        },
        debug: debug
          ? {
              tokenPresent: Boolean(token),
              tokenFingerprint: token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) : null,
              responseStatus: productResult.responseStatus,
              responseOk: productResult.responseOk,
              responseErrors: productResult.responseErrors,
              responseExtensions: productResult.responseExtensions,
              handle,
              productUrl,
            }
          : undefined,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
