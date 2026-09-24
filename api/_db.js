const { Pool } = require('pg');

let pool;
let schemaReady;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  return pool;
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const client = await getPool().connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS creem_webhook_events (
          id BIGSERIAL PRIMARY KEY,
          event_id TEXT UNIQUE NOT NULL,
          event_type TEXT NOT NULL,
          checkout_id TEXT,
          customer_id TEXT,
          customer_email TEXT,
          product_id TEXT,
          plan TEXT,
          status TEXT NOT NULL,
          raw_event JSONB NOT NULL,
          processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id BIGSERIAL PRIMARY KEY,
          dedupe_key TEXT UNIQUE NOT NULL,
          shop_domain TEXT,
          request_id TEXT,
          customer_email TEXT,
          customer_id TEXT,
          product_id TEXT,
          plan TEXT,
          status TEXT NOT NULL,
          checkout_id TEXT,
          source_event_id TEXT UNIQUE NOT NULL,
          raw_event JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS shop_domain TEXT
      `);
      await client.query(`
        ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS request_id TEXT
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS subscriptions_shop_domain_idx
        ON subscriptions (shop_domain)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS checkout_sessions (
          id BIGSERIAL PRIMARY KEY,
          request_id TEXT UNIQUE NOT NULL,
          shop_domain TEXT NOT NULL,
          plan TEXT NOT NULL,
          product_id TEXT,
          checkout_id TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS checkout_sessions_shop_domain_idx
        ON checkout_sessions (shop_domain)
      `);
    } finally {
      client.release();
    }
  })();

  return schemaReady;
}

module.exports = { getPool, ensureSchema };
