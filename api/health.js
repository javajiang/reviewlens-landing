const { Pool } = require('pg');

let pool;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 1,
  });

  return pool;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.query?.config === 'supabase') {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const publishableKey = String(
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      ''
    ).trim();

    res.status(200).json({
      ok: Boolean(url && publishableKey),
      supabase: {
        url: url || null,
        publishableKey: publishableKey || null,
      },
    });
    return;
  }

  try {
    const client = await getPool().connect();
    try {
      const result = await client.query('SELECT 1 AS ok');
      res.status(200).json({
        ok: true,
        database: 'connected',
        result: result.rows[0],
      });
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: 'error',
      message: error.message,
    });
  }
};
