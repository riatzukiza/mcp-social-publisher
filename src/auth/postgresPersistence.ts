import { initSchema } from "../lib/postgres.js";
import { getSql } from "../lib/postgres.js";
import type { Persistence, SerializableClient, SerializableCode, SerializableRefreshTokenReuse, SerializableToken } from "./types.js";

export class PostgresPersistence implements Persistence {
  async init(): Promise<void> {
    await initSchema();
    await this.cleanup();
  }

  async stop(): Promise<void> {}

  async getCode(code: string): Promise<SerializableCode | undefined> {
    const sql = getSql();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM oauth_codes WHERE code = ${code} AND expires_at > NOW()
    `;
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value) as SerializableCode;
  }

  async setCode(code: string, value: SerializableCode): Promise<void> {
    const sql = getSql();
    const expiresAt = new Date(value.expiresAt * 1000);
    await sql`
      INSERT INTO oauth_codes (code, value, expires_at)
      VALUES (${code}, ${JSON.stringify(value)}::jsonb, ${expiresAt})
      ON CONFLICT (code) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
    `;
  }

  async deleteCode(code: string): Promise<void> {
    const sql = getSql();
    await sql`DELETE FROM oauth_codes WHERE code = ${code}`;
  }

  async getAccessToken(token: string): Promise<SerializableToken | undefined> {
    const sql = getSql();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM oauth_tokens WHERE token = ${token} AND expires_at > NOW()
    `;
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value) as SerializableToken;
  }

  async setAccessToken(token: string, value: SerializableToken): Promise<void> {
    const sql = getSql();
    const expiresAt = new Date(value.expiresAt * 1000);
    await sql`
      INSERT INTO oauth_tokens (token, value, expires_at)
      VALUES (${token}, ${JSON.stringify(value)}::jsonb, ${expiresAt})
      ON CONFLICT (token) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
    `;
  }

  async deleteAccessToken(token: string): Promise<void> {
    const sql = getSql();
    await sql`DELETE FROM oauth_tokens WHERE token = ${token}`;
  }

  async getRefreshToken(token: string): Promise<SerializableToken | undefined> {
    const sql = getSql();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM oauth_refresh_tokens WHERE token = ${token} AND expires_at > NOW()
    `;
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value) as SerializableToken;
  }

  async setRefreshToken(token: string, value: SerializableToken): Promise<void> {
    const sql = getSql();
    const expiresAt = new Date(value.expiresAt * 1000);
    await sql`
      INSERT INTO oauth_refresh_tokens (token, value, expires_at)
      VALUES (${token}, ${JSON.stringify(value)}::jsonb, ${expiresAt})
      ON CONFLICT (token) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
    `;
  }

  async deleteRefreshToken(token: string): Promise<void> {
    const sql = getSql();
    await sql`DELETE FROM oauth_refresh_tokens WHERE token = ${token}`;
  }

  async consumeRefreshToken(token: string): Promise<SerializableToken | undefined> {
    const sql = getSql();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM oauth_refresh_tokens WHERE token = ${token} AND expires_at > NOW()
    `;
    if (rows.length === 0) return undefined;
    await sql`DELETE FROM oauth_refresh_tokens WHERE token = ${token}`;
    return JSON.parse(rows[0].value) as SerializableToken;
  }

  async getRefreshTokenReuse(oldRefreshToken: string): Promise<SerializableRefreshTokenReuse | undefined> {
    const sql = getSql();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM oauth_refresh_reuse WHERE old_token = ${oldRefreshToken} AND expires_at > NOW()
    `;
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value) as SerializableRefreshTokenReuse;
  }

  async setRefreshTokenReuse(oldRefreshToken: string, value: SerializableRefreshTokenReuse): Promise<void> {
    const sql = getSql();
    const expiresAt = new Date(value.expiresAt * 1000);
    await sql`
      INSERT INTO oauth_refresh_reuse (old_token, value, expires_at)
      VALUES (${oldRefreshToken}, ${JSON.stringify(value)}::jsonb, ${expiresAt})
      ON CONFLICT (old_token) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
    `;
  }

  async getClient(clientId: string): Promise<SerializableClient | undefined> {
    const sql = getSql();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM oauth_clients WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value) as SerializableClient;
  }

  async setClient(clientId: string, value: SerializableClient): Promise<void> {
    const sql = getSql();
    await sql`
      INSERT INTO oauth_clients (client_id, value)
      VALUES (${clientId}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (client_id) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async cleanup(): Promise<number> {
    const sql = getSql();
    const codes = await sql`DELETE FROM oauth_codes WHERE expires_at <= NOW()`;
    const tokens = await sql`DELETE FROM oauth_tokens WHERE expires_at <= NOW()`;
    const refresh = await sql`DELETE FROM oauth_refresh_tokens WHERE expires_at <= NOW()`;
    const reuse = await sql`DELETE FROM oauth_refresh_reuse WHERE expires_at <= NOW()`;
    return codes.count + tokens.count + refresh.count + reuse.count;
  }
}