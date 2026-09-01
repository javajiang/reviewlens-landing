const crypto = require('crypto');
const { URL } = require('url');
const { getAppBaseUrl, saveInstallation, verifyShopifyHmac, verifyStateCookie } = require('../_shopify');

async function exchangeCodeForToken({ shop, code }) {
  const key = String(process.env.SHOPIFY_API_KEY || '');
  const secret = String(process.env.SHOPIFY_API_SECRET || '');
  if (!key) throw new Error('SHOPIFY_API_KEY is not set');
  if (!secret) throw new Error('SHOPIFY_API_SECRET is not set');

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: key,
      client_secret: secret,
      code,
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
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return data;
}

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).send('Method not allowed');
      return;
    }

    const parsed = new URL(req.url, getAppBaseUrl(req));
    const shop = String(parsed.searchParams.get('shop') || '').trim().toLowerCase();
    const code = String(parsed.searchParams.get('code') || '').trim();
    const state = String(parsed.searchParams.get('state') || '').trim();

    if (!shop || !isValidShop(shop)) {
      res.status(400).send('Invalid shop');
      return;
    }
    if (!code) {
      res.status(400).send('Missing code');
      return;
    }
    if (!verifyShopifyHmac(Object.fromEntries(parsed.searchParams.entries()))) {
      res.status(400).send('Invalid HMAC');
      return;
    }
    if (!state || !verifyStateCookie(state, req.headers.cookie)) {
      res.status(400).send('Invalid state');
      return;
    }

    const tokenData = await exchangeCodeForToken({ shop, code });
    const accessToken = String(tokenData.access_token || tokenData.accessToken || '');
    const scope = String(tokenData.scope || '');

    if (!accessToken) {
      throw new Error('Missing access token');
    }

    await saveInstallation({ shop, accessToken, scope });

    const baseUrl = getAppBaseUrl(req);
    const successUrl = new URL('/success.html', baseUrl);
    successUrl.searchParams.set('shop', shop);
    successUrl.searchParams.set('installed', 'true');

    res.writeHead(302, { Location: successUrl.toString() });
    res.end();
  } catch (error) {
    res.status(500).send(`Shopify callback failed: ${error.message}`);
  }
};
