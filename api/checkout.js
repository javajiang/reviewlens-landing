const { URL } = require('url');

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

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const parsed = new URL(req.url, getBaseUrl(req));
    const plan = parsed.searchParams.get('plan') === 'pro' ? 'pro' : 'basic';
    const productId = getProductId(plan);

    if (!process.env.CREEM_API_KEY) {
      res.status(500).json({ ok: false, error: 'CREEM_API_KEY is not set' });
      return;
    }

    if (!productId) {
      res.status(500).json({ ok: false, error: `Missing product id for plan: ${plan}` });
      return;
    }

    const payload = {
      product_id: productId,
      request_id: `reviewlens-${plan}-${Date.now()}`,
      success_url: `${getBaseUrl(req)}/success.html?plan=${plan}`,
      cancel_url: `${getBaseUrl(req)}/#pricing`,
    };

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

    res.writeHead(302, { Location: checkoutUrl });
    res.end();
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
