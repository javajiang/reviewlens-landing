const { buildInstallUrl, buildStateCookie } = require('../_shopify');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const shop = String(req.query.shop || '').trim().toLowerCase();
    if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      res.status(400).json({ ok: false, error: 'Invalid or missing shop parameter' });
      return;
    }

    const { url, state } = buildInstallUrl(req, shop);
    res.setHeader('Set-Cookie', buildStateCookie(state));
    res.writeHead(302, { Location: url });
    res.end();
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
