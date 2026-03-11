import postgres from "postgres";

let sql: postgres.Sql | null = null;

export function getSql(): postgres.Sql {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    sql = postgres(url, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sql;
}

export async function closeSql(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

export async function initSchema(): Promise<void> {
  const s = getSql();
  await s`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await s`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await s`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await s`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await s`
    CREATE TABLE IF NOT EXISTS oauth_refresh_reuse (
      old_token TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await s`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `;
  await s`
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at)
  `;
  await s`
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at)
  `;
  await s`
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expires ON oauth_refresh_tokens(expires_at)
  `;
}