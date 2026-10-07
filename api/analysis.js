const { ensureSchema, getPool } = require('./_db');
const { ensureShopifySchema, normalizeShopDomain } = require('./_shopify');
const { getUserFromRequest } = require('./_auth');

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function getShop(req) {
  return normalizeShopDomain(
    req.query?.shop ||
    req.query?.shopDomain ||
    req.body?.shop ||
    req.body?.shopDomain
  );
}

async function getAccessStatus(shop, userId) {
  await ensureSchema();
  const client = await getPool().connect();

  try {
    let authorized = null;
    if (shop) {
      await ensureShopifySchema();
      const installation = await client.query(
        'SELECT shop_domain FROM shopify_installations WHERE shop_domain = $1 LIMIT 1',
        [shop]
      );
      authorized = Boolean(installation.rows[0]);
    }

    const result = await client.query(
      `
        SELECT plan, status, updated_at
        FROM subscriptions
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [userId]
    );
    const subscription = result.rows[0] || null;
    return {
      authorized,
      paid: Boolean(subscription),
      plan: subscription?.plan || null,
      updatedAt: subscription?.updated_at || null,
    };
  } finally {
    client.release();
  }
}

module.exports = async (req, res) => {
  try {
    const shop = getShop(req);
    if (shop && !isValidShop(shop)) {
      res.status(400).json({ ok: false, error: 'Invalid shop parameter' });
      return;
    }

    if (req.method === 'GET') {
      const user = await getUserFromRequest(req);
      if (!user) {
        res.status(401).json({ ok: false, authenticated: false, error: 'Login is required' });
        return;
      }
      const access = await getAccessStatus(shop, user.id);
      res.status(200).json({ ok: true, ...access });
      return;
    }

    if (req.method === 'POST') {
      if (!shop) {
        res.status(400).json({ ok: false, error: 'Shop is required for AI analysis' });
        return;
      }
      const user = await getUserFromRequest(req);
      if (!user) {
        res.status(401).json({ ok: false, authenticated: false, error: 'Login is required' });
        return;
      }
      const access = await getAccessStatus(shop, user.id);
      if (!access.authorized) {
        res.status(403).json({
          ok: false,
          authorized: false,
          paid: false,
          error: 'Shop is not authorized',
        });
        return;
      }
      if (!access.paid) {
        res.status(402).json({
          ok: false,
          authorized: true,
          paid: false,
          error: 'AI analysis requires an active Pro subscription',
        });
        return;
      }

      res.status(501).json({
        ok: false,
        authorized: true,
        paid: true,
        plan: access.plan,
        error: 'AI analysis is not enabled yet',
      });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
