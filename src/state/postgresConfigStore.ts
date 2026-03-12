import { getSql } from "../lib/postgres.js";
import type { BlueskyTarget, ConfigState, DiscordTarget, DiscordTargetInput, GitHubOAuthConfig, PublicTargetSummary } from "./configStore.js";
import { describeDiscordTarget, normalizeDiscordTarget, normalizeLogin, normalizeServiceUrl, normalizeTargetKey } from "./configStore.js";

type ConfigRow = {
  key: string;
  value: string;
};

type ConfigRowJson = {
  githubOAuth?: GitHubOAuthConfig;
  allowedGitHubUsers?: string[];
  targets?: {
    discord?: DiscordTarget[];
    bluesky?: BlueskyTarget[];
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyRow(initialGitHubUsers: readonly string[]): ConfigRowJson {
  return {
    githubOAuth: { clientId: "", clientSecret: "", updatedAt: "" },
    allowedGitHubUsers: [...new Set(initialGitHubUsers.map(normalizeLogin).filter(Boolean))].sort(),
    targets: { discord: [], bluesky: [] },
  };
}

export class PostgresConfigStore {
  private initialized = false;
  private initialGitHubUsers: string[];

  constructor(options: { initialGitHubUsers: string[] }) {
    this.initialGitHubUsers = options.initialGitHubUsers;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const sql = getSql();
    const rows = await sql<ConfigRow[]>`
      SELECT key, value FROM config WHERE key = 'global'
    `;
    if (rows.length === 0) {
      const initial = emptyRow(this.initialGitHubUsers);
      await sql`
        INSERT INTO config (key, value) VALUES ('global', ${JSON.stringify(initial)}::jsonb)
      `;
    }
    this.initialized = true;
  }

  private async load(): Promise<ConfigRowJson> {
    const sql = getSql();
    const rows = await sql<ConfigRow[]>`
      SELECT value FROM config WHERE key = 'global'
    `;
    if (rows.length === 0) {
      return emptyRow(this.initialGitHubUsers);
    }
    const parsed = JSON.parse(rows[0].value) as ConfigRowJson;
    return this.mergeWithDefaults(parsed);
  }

  private async save(data: ConfigRowJson): Promise<void> {
    const sql = getSql();
    await sql`
      UPDATE config SET value = ${JSON.stringify(data)}::jsonb, updated_at = NOW() WHERE key = 'global'
    `;
  }

  private mergeWithDefaults(parsed: ConfigRowJson): ConfigRowJson {
    return {
      githubOAuth: parsed.githubOAuth ?? { clientId: "", clientSecret: "", updatedAt: "" },
      allowedGitHubUsers: [...new Set([
        ...this.initialGitHubUsers.map(normalizeLogin),
        ...(parsed.allowedGitHubUsers ?? []),
      ].filter(Boolean))].sort(),
      targets: {
        discord: Array.isArray(parsed.targets?.discord)
          ? parsed.targets.discord.map((target) => normalizeDiscordTarget(target)).filter((target): target is DiscordTarget => target !== null)
          : [],
        bluesky: parsed.targets?.bluesky ?? [],
      },
    };
  }

  async getSnapshot(): Promise<ConfigState> {
    const data = await this.load();
    return {
      githubOAuth: data.githubOAuth ?? { clientId: "", clientSecret: "", updatedAt: "" },
      allowedGitHubUsers: data.allowedGitHubUsers ?? [],
      targets: {
        discord: data.targets?.discord ?? [],
        bluesky: data.targets?.bluesky ?? [],
      },
      updatedAt: new Date().toISOString(),
    };
  }

  async getPublicTargets(): Promise<PublicTargetSummary[]> {
    const data = await this.load();
    return [
      ...(data.targets?.discord ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        platform: "discord" as const,
        destination: describeDiscordTarget(t),
      })),
      ...(data.targets?.bluesky ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        platform: "bluesky" as const,
        destination: `${t.identifier} via ${t.serviceUrl}`,
      })),
    ];
  }

  async hasGitHubOAuthConfig(): Promise<boolean> {
    const data = await this.load();
    return (data.githubOAuth?.clientId?.length ?? 0) > 0 && (data.githubOAuth?.clientSecret?.length ?? 0) > 0;
  }

  async isAllowedGitHubUser(login: string): Promise<boolean> {
    const data = await this.load();
    return data.allowedGitHubUsers?.includes(normalizeLogin(login)) ?? false;
  }

  async getDiscordTarget(nameOrId: string): Promise<DiscordTarget | undefined> {
    const needle = normalizeTargetKey(nameOrId);
    const data = await this.load();
    return data.targets?.discord?.find((t) => t.id === needle || normalizeTargetKey(t.name) === needle);
  }

  async getBlueskyTarget(nameOrId: string): Promise<BlueskyTarget | undefined> {
    const needle = normalizeTargetKey(nameOrId);
    const data = await this.load();
    return data.targets?.bluesky?.find((t) => t.id === needle || normalizeTargetKey(t.name) === needle);
  }

  async setGitHubOAuth(clientId: string, clientSecret: string): Promise<void> {
    const data = await this.load();
    data.githubOAuth = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      updatedAt: nowIso(),
    };
    await this.save(data);
  }

  async addGitHubUser(login: string): Promise<void> {
    const normalized = normalizeLogin(login);
    if (!normalized) return;
    const data = await this.load();
    data.allowedGitHubUsers = [...new Set([...(data.allowedGitHubUsers ?? []), normalized])].sort();
    await this.save(data);
  }

  async removeGitHubUser(login: string): Promise<void> {
    const normalized = normalizeLogin(login);
    const data = await this.load();
    data.allowedGitHubUsers = (data.allowedGitHubUsers ?? []).filter((u) => u !== normalized);
    await this.save(data);
  }

  async upsertDiscordTarget(input: DiscordTargetInput): Promise<void> {
    const id = normalizeTargetKey(input.name);
    if (!id) return;
    const webhookUrl = input.webhookUrl.trim();
    const botToken = input.botToken?.trim() ?? "";
    const userToken = input.userToken?.trim() ?? "";
    const channelId = input.channelId?.trim() ?? "";
    const delivery = input.delivery ?? (webhookUrl ? "webhook" : userToken ? "userbot" : "bot");
    if (delivery === "webhook" && !webhookUrl) return;
    if (delivery === "bot" && (!botToken || !channelId)) return;
    if (delivery === "userbot" && (!userToken || !channelId)) return;

    const data = await this.load();
    const existing = data.targets?.discord?.find((t) => t.id === id);
    const createdAt = existing?.createdAt ?? nowIso();
    const next: DiscordTarget = {
      id,
      name: input.name.trim(),
      delivery,
      webhookUrl,
      botToken,
      userToken,
      channelId,
      username: input.username?.trim() ?? "",
      avatarUrl: input.avatarUrl?.trim() ?? "",
      proxyUrl: input.proxyUrl?.trim() ?? "",
      headless: input.headless ?? delivery === "userbot",
      createdAt,
      updatedAt: nowIso(),
    };
    data.targets = data.targets ?? { discord: [], bluesky: [] };
    data.targets.discord = [
      ...(data.targets.discord ?? []).filter((t) => t.id !== id),
      next,
    ].sort((a, b) => a.name.localeCompare(b.name));
    await this.save(data);
  }

  async removeDiscordTarget(nameOrId: string): Promise<void> {
    const needle = normalizeTargetKey(nameOrId);
    const data = await this.load();
    data.targets = data.targets ?? { discord: [], bluesky: [] };
    data.targets.discord = (data.targets.discord ?? []).filter(
      (t) => t.id !== needle && normalizeTargetKey(t.name) !== needle
    );
    await this.save(data);
  }

  async upsertBlueskyTarget(input: {
    name: string;
    identifier: string;
    appPassword: string;
    serviceUrl: string;
  }): Promise<void> {
    const id = normalizeTargetKey(input.name);
    if (!id) return;
    const data = await this.load();
    const existing = data.targets?.bluesky?.find((t) => t.id === id);
    const createdAt = existing?.createdAt ?? nowIso();
    const next: BlueskyTarget = {
      id,
      name: input.name.trim(),
      identifier: input.identifier.trim(),
      appPassword: input.appPassword.trim(),
      serviceUrl: normalizeServiceUrl(input.serviceUrl),
      createdAt,
      updatedAt: nowIso(),
    };
    data.targets = data.targets ?? { discord: [], bluesky: [] };
    data.targets.bluesky = [
      ...(data.targets.bluesky ?? []).filter((t) => t.id !== id),
      next,
    ].sort((a, b) => a.name.localeCompare(b.name));
    await this.save(data);
  }

  async removeBlueskyTarget(nameOrId: string): Promise<void> {
    const needle = normalizeTargetKey(nameOrId);
    const data = await this.load();
    data.targets = data.targets ?? { discord: [], bluesky: [] };
    data.targets.bluesky = (data.targets.bluesky ?? []).filter(
      (t) => t.id !== needle && normalizeTargetKey(t.name) !== needle
    );
    await this.save(data);
  }
}
