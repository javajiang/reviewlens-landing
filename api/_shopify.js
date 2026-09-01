const crypto = require('crypto');
const { getPool } = require('./_db');

function getAppBaseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/$/, '');

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function getShopifyApiKey() {
  return String(process.env.SHOPIFY_API_KEY || '');
}

function getShopifyApiSecret() {
  return String(process.env.SHOPIFY_API_SECRET || '');
}

function buildSignedStateToken() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', getShopifyApiSecret()).update(nonce).digest('hex');
  return `${nonce}.${sig}`;
}

function verifySignedStateToken(token) {
  const raw = String(token || '');
  const [nonce, sig] = raw.split('.');
  if (!nonce || !sig) return false;

  const expected = crypto.createHmac('sha256', getShopifyApiSecret()).update(nonce).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildInstallUrl(req, shop) {
  const key = getShopifyApiKey();
  if (!key) throw new Error('SHOPIFY_API_KEY is not set');

  const baseUrl = getAppBaseUrl(req);
  const scopes = String(process.env.SHOPIFY_SCOPES || '').trim();
  const redirectUri = String(process.env.SHOPIFY_REDIRECT_URL || `${baseUrl}/api/shopify/callback`).trim();
  const state = buildSignedStateToken();

  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', key);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('grant_options[]', 'per-user');
  if (scopes) url.searchParams.set('scope', scopes);

  return { url: url.toString(), state, redirectUri };
}

function signState(state) {
  const secret = getShopifyApiSecret();
  return crypto.createHmac('sha256', secret).update(state).digest('hex');
}

function buildStateCookie(state) {
  const signed = `${state}.${signState(state)}`;
  const parts = [
    `reviewlens_shopify_state=${signed}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ];
  return parts.join('; ');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  const raw = String(cookieHeader || '');
  for (const chunk of raw.split(';')) {
    const [key, ...rest] = chunk.trim().split('=');
    if (!key) continue;
    cookies[key] = rest.join('=');
  }
  return cookies;
}

function verifyStateCookie(reqState, cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies.reviewlens_shopify_state;
  if (!raw) return false;

  const [cookieState, signature] = raw.split('.');
  if (!cookieState || !signature || cookieState !== reqState) return false;

  const expected = signState(cookieState);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyState(reqState, cookieHeader) {
  if (verifySignedStateToken(reqState)) return true;
  return verifyStateCookie(reqState, cookieHeader);
}

function verifyShopifyHmac(query) {
  const secret = getShopifyApiSecret();
  if (!secret) throw new Error('SHOPIFY_API_SECRET is not set');

  const provided = String(query.hmac || '');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'hmac' || key === 'signature') continue;
    if (value === undefined || value === null || value === '') continue;
    params.append(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(digest, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function ensureShopifySchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS shopify_installations (
        id BIGSERIAL PRIMARY KEY,
        shop_domain TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        scope TEXT,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

async function saveInstallation({ shop, accessToken, scope }) {
  await ensureShopifySchema();
  const client = await getPool().connect();
  try {
    await client.query(
      `
        INSERT INTO shopify_installations (shop_domain, access_token, scope)
        VALUES ($1, $2, $3)
        ON CONFLICT (shop_domain) DO UPDATE SET
          access_token = EXCLUDED.access_token,
          scope = EXCLUDED.scope,
          updated_at = NOW()
      `,
      [shop, accessToken, scope || null]
    );
  } finally {
    client.release();
  }
}

module.exports = {
  getAppBaseUrl,
  buildInstallUrl,
  buildStateCookie,
  verifyShopifyHmac,
  verifyState,
  verifyStateCookie,
  saveInstallation,
  ensureShopifySchema,
};
