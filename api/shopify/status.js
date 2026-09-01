const { getPool } = require('../_db');

module.exports = async (req, res) => {
  try {
    const client = await getPool().connect();
    try {
      const result = await client.query(
        'select shop_domain, scope, installed_at, updated_at from shopify_installations order by updated_at desc limit 20'
      );
      res.status(200).json({ ok: true, installations: result.rows });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
