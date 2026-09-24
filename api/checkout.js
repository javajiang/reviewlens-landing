const { URL } = require('url');
const { getPool, ensureSchema } = require('./_db');
const { ensureShopifySchema, normalizeShopDomain } = require('./_shopify');

function getBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function getCreemBaseUrl() {
  const env = String(process.env.CREEM_ENV || '').toLowerCase();
  const apiKey = String(process.env.CREEM_API_KEY || '');

  if (env === 'prod' || env === 'production') {
    return 'https://api.creem.io';
  }
  if (env === 'test') {
    return 'https://test-api.creem.io';
  }
  if (apiKey.startsWith('creem_test_')) {
    return 'https://test-api.creem.io';
  }
  return 'https://test-api.creem.io';
}

function getProductId(plan) {
  if (plan === 'pro') return process.env.CREEM_PRO_PRODUCT_ID;
  return process.env.CREEM_BASIC_PRODUCT_ID;
}

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

    const parsed = new URL(req.url, getBaseUrl(req));
    const plan = parsed.searchParams.get('plan') === 'pro' ? 'pro' : 'basic';
    const shop = normalizeShopDomain(parsed.searchParams.get('shop'));
    const productId = getProductId(plan);

    if (!shop || !isValidShop(shop)) {
      res.status(400).json({ ok: false, error: 'A valid Shopify shop is required' });
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
        res.status(403).json({ ok: false, authorized: false, error: 'Shop is not authorized' });
        return;
      }
    } finally {
      client.release();
    }

    if (!process.env.CREEM_API_KEY) {
      res.status(500).json({ ok: false, error: 'CREEM_API_KEY is not set' });
      return;
    }

    if (!productId) {
      res.status(500).json({ ok: false, error: `Missing product id for plan: ${plan}` });
      return;
    }

    const requestId = `reviewlens-${plan}-${shop}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payload = {
      product_id: productId,
      request_id: requestId,
      success_url: `${getBaseUrl(req)}/success.html?plan=${plan}`,
    };

    const sessionClient = await getPool().connect();
    try {
      await sessionClient.query(
        `
          INSERT INTO checkout_sessions (request_id, shop_domain, plan, product_id)
          VALUES ($1, $2, $3, $4)
        `,
        [requestId, shop, plan, productId]
      );
    } finally {
      sessionClient.release();
    }

    const response = await fetch(`${getCreemBaseUrl()}/v1/checkouts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.CREEM_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      res.status(response.status).json({
        ok: false,
        error: 'Failed to create checkout',
        details: data,
      });
      return;
    }

    const checkoutUrl =
      data.checkout_url ||
      data.checkoutUrl ||
      data.url ||
      data.data?.checkout_url ||
      data.data?.checkoutUrl ||
      data.data?.url;

    if (!checkoutUrl) {
      res.status(502).json({
        ok: false,
        error: 'Creem response did not include a checkout URL',
        details: data,
      });
      return;
    }

    const checkoutId =
      data.id ||
      data.checkout_id ||
      data.checkoutId ||
      data.data?.id ||
      data.data?.checkout_id ||
      data.data?.checkoutId;
    if (checkoutId) {
      const updateClient = await getPool().connect();
      try {
        await updateClient.query(
          `
            UPDATE checkout_sessions
            SET checkout_id = $2, updated_at = NOW()
            WHERE request_id = $1
          `,
          [requestId, String(checkoutId)]
        );
      } finally {
        updateClient.release();
      }
    }

    res.writeHead(302, { Location: checkoutUrl });
    res.end();
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
