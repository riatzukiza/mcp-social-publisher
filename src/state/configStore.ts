import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  updatedAt: string;
};

export type DiscordDelivery = "webhook" | "bot" | "userbot";

export type DiscordTarget = {
  id: string;
  name: string;
  delivery: DiscordDelivery;
  webhookUrl: string;
  botToken: string;
  userToken: string;
  channelId: string;
  username: string;
  avatarUrl: string;
  proxyUrl: string;
  headless: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DiscordTargetInput = {
  name: string;
  delivery?: DiscordDelivery;
  webhookUrl: string;
  botToken?: string;
  userToken?: string;
  channelId?: string;
  username?: string;
  avatarUrl?: string;
  proxyUrl?: string;
  headless?: boolean;
};

export type BlueskyTarget = {
  id: string;
  name: string;
  identifier: string;
  appPassword: string;
  serviceUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type ConfigState = {
  githubOAuth: GitHubOAuthConfig;
  allowedGitHubUsers: string[];
  targets: {
    discord: DiscordTarget[];
    bluesky: BlueskyTarget[];
  };
  updatedAt: string;
};

export type PublicTargetSummary = {
  id: string;
  name: string;
  platform: "discord" | "bluesky";
  destination: string;
};

export interface IConfigStore {
  init(): Promise<void>;
  getSnapshot(): Promise<ConfigState>;
  getPublicTargets(): Promise<PublicTargetSummary[]>;
  hasGitHubOAuthConfig(): Promise<boolean>;
  isAllowedGitHubUser(login: string): Promise<boolean>;
  getDiscordTarget(nameOrId: string): Promise<DiscordTarget | undefined>;
  getBlueskyTarget(nameOrId: string): Promise<BlueskyTarget | undefined>;
  setGitHubOAuth(clientId: string, clientSecret: string): Promise<void>;
  addGitHubUser(login: string): Promise<void>;
  removeGitHubUser(login: string): Promise<void>;
  upsertDiscordTarget(input: DiscordTargetInput): Promise<void>;
  removeDiscordTarget(nameOrId: string): Promise<void>;
  upsertBlueskyTarget(input: {
    name: string;
    identifier: string;
    appPassword: string;
    serviceUrl: string;
  }): Promise<void>;
  removeBlueskyTarget(nameOrId: string): Promise<void>;
}

type ConfigStoreOptions = {
  initialGitHubUsers: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(initialGitHubUsers: readonly string[]): ConfigState {
  return {
    githubOAuth: {
      clientId: "",
      clientSecret: "",
      updatedAt: "",
    },
    allowedGitHubUsers: Array.from(new Set(initialGitHubUsers.map(normalizeLogin).filter(Boolean))).sort(),
    targets: {
      discord: [],
      bluesky: [],
    },
    updatedAt: nowIso(),
  };
}

export class ConfigStore implements IConfigStore {
  private state: ConfigState;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly options: ConfigStoreOptions,
  ) {
    this.state = emptyState(options.initialGitHubUsers);
  }

  public async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw), this.options.initialGitHubUsers);
    } catch {
      this.state = emptyState(this.options.initialGitHubUsers);
      await this.persist();
    }
  }

  public async getSnapshot(): Promise<ConfigState> {
    return JSON.parse(JSON.stringify(this.state)) as ConfigState;
  }

  public async getPublicTargets(): Promise<PublicTargetSummary[]> {
    return [
      ...this.state.targets.discord.map((target) => ({
        id: target.id,
        name: target.name,
        platform: "discord" as const,
        destination: describeDiscordTarget(target),
      })),
      ...this.state.targets.bluesky.map((target) => ({
        id: target.id,
        name: target.name,
        platform: "bluesky" as const,
        destination: `${target.identifier} via ${target.serviceUrl}`,
      })),
    ];
  }

  public async hasGitHubOAuthConfig(): Promise<boolean> {
    return this.state.githubOAuth.clientId.length > 0 && this.state.githubOAuth.clientSecret.length > 0;
  }

  public async isAllowedGitHubUser(login: string): Promise<boolean> {
    return this.state.allowedGitHubUsers.includes(normalizeLogin(login));
  }

  public async getDiscordTarget(nameOrId: string): Promise<DiscordTarget | undefined> {
    const needle = normalizeTargetKey(nameOrId);
    return this.state.targets.discord.find((target) => target.id === needle || normalizeTargetKey(target.name) === needle);
  }

  public async getBlueskyTarget(nameOrId: string): Promise<BlueskyTarget | undefined> {
    const needle = normalizeTargetKey(nameOrId);
    return this.state.targets.bluesky.find((target) => target.id === needle || normalizeTargetKey(target.name) === needle);
  }

  public async setGitHubOAuth(clientId: string, clientSecret: string): Promise<void> {
    await this.writeState(() => {
      this.state.githubOAuth = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        updatedAt: nowIso(),
      };
    });
  }

  public async addGitHubUser(login: string): Promise<void> {
    const normalized = normalizeLogin(login);
    if (!normalized) {
      return;
    }
    await this.writeState(() => {
      this.state.allowedGitHubUsers = Array.from(new Set([...this.state.allowedGitHubUsers, normalized])).sort();
    });
  }

  public async removeGitHubUser(login: string): Promise<void> {
    const normalized = normalizeLogin(login);
    await this.writeState(() => {
      this.state.allowedGitHubUsers = this.state.allowedGitHubUsers.filter((entry) => entry !== normalized);
    });
  }

  public async upsertDiscordTarget(input: DiscordTargetInput): Promise<void> {
    const id = normalizeTargetKey(input.name);
    if (!id) {
      return;
    }
    const webhookUrl = input.webhookUrl.trim();
    const botToken = input.botToken?.trim() ?? "";
    const userToken = input.userToken?.trim() ?? "";
    const channelId = input.channelId?.trim() ?? "";
    const delivery = normalizeDiscordDelivery(input.delivery ?? inferDiscordDelivery(webhookUrl, botToken, userToken));
    if (delivery === "bot" && (!botToken || !channelId)) {
      return;
    }
    if (delivery === "userbot" && (!userToken || !channelId)) {
      return;
    }
    if (delivery === "webhook" && !webhookUrl) {
      return;
    }
    const existing = this.state.targets.discord.find((target) => target.id === id);
    const createdAt = existing?.createdAt ?? nowIso();
    await this.writeState(() => {
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
      this.state.targets.discord = [
        ...this.state.targets.discord.filter((target) => target.id !== id),
        next,
      ].sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  public async removeDiscordTarget(nameOrId: string): Promise<void> {
    const needle = normalizeTargetKey(nameOrId);
    await this.writeState(() => {
      this.state.targets.discord = this.state.targets.discord.filter((target) => target.id !== needle && normalizeTargetKey(target.name) !== needle);
    });
  }

  public async upsertBlueskyTarget(input: {
    name: string;
    identifier: string;
    appPassword: string;
    serviceUrl: string;
  }): Promise<void> {
    const id = normalizeTargetKey(input.name);
    if (!id) {
      return;
    }
    const existing = this.state.targets.bluesky.find((target) => target.id === id);
    const createdAt = existing?.createdAt ?? nowIso();
    await this.writeState(() => {
      const next: BlueskyTarget = {
        id,
        name: input.name.trim(),
        identifier: input.identifier.trim(),
        appPassword: input.appPassword.trim(),
        serviceUrl: normalizeServiceUrl(input.serviceUrl),
        createdAt,
        updatedAt: nowIso(),
      };
      this.state.targets.bluesky = [
        ...this.state.targets.bluesky.filter((target) => target.id !== id),
        next,
      ].sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  public async removeBlueskyTarget(nameOrId: string): Promise<void> {
    const needle = normalizeTargetKey(nameOrId);
    await this.writeState(() => {
      this.state.targets.bluesky = this.state.targets.bluesky.filter((target) => target.id !== needle && normalizeTargetKey(target.name) !== needle);
    });
  }

  private async writeState<T>(mutate: () => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const result = await mutate();
      this.state.updatedAt = nowIso();
      await this.persist();
      return result;
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTargetKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeServiceUrl(value: string): string {
  const trimmed = value.trim();
  const raw = trimmed.length > 0 ? trimmed : "https://bsky.social";
  const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return value.length === 0 ? "not set" : "configured";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function describeDiscordTarget(target: DiscordTarget): string {
  if (target.delivery === "bot") {
    return `channel ${target.channelId} via bot token`;
  }
  if (target.delivery === "userbot") {
    return `channel ${target.channelId} via user-bot${target.headless ? " (headless)" : ""}`;
  }
  try {
    const url = new URL(target.webhookUrl);
    return `${url.hostname}${url.pathname.split("/").slice(-2).join("/")}`;
  } catch {
    return maskSecret(target.webhookUrl);
  }
}

function normalizeState(raw: unknown, initialGitHubUsers: readonly string[]): ConfigState {
  const base = emptyState(initialGitHubUsers);
  if (!raw || typeof raw !== "object") {
    return base;
  }

  const candidate = raw as Record<string, unknown>;
  const githubOAuthRaw = candidate.githubOAuth as Record<string, unknown> | undefined;
  const targetsRaw = candidate.targets as Record<string, unknown> | undefined;

  return {
    githubOAuth: {
      clientId: typeof githubOAuthRaw?.clientId === "string" ? githubOAuthRaw.clientId.trim() : "",
      clientSecret: typeof githubOAuthRaw?.clientSecret === "string" ? githubOAuthRaw.clientSecret.trim() : "", // pragma: allowlist secret
      updatedAt: typeof githubOAuthRaw?.updatedAt === "string" ? githubOAuthRaw.updatedAt : "",
    },
    allowedGitHubUsers: Array.from(new Set([
      ...initialGitHubUsers.map(normalizeLogin),
      ...(Array.isArray(candidate.allowedGitHubUsers) ? candidate.allowedGitHubUsers.map((value) => normalizeLogin(String(value))) : []),
    ].filter(Boolean))).sort(),
    targets: {
      discord: Array.isArray(targetsRaw?.discord)
        ? targetsRaw.discord.map((value) => normalizeDiscordTarget(value)).filter((value): value is DiscordTarget => value !== null)
        : [],
      bluesky: Array.isArray(targetsRaw?.bluesky)
        ? targetsRaw.bluesky.map((value) => normalizeBlueskyTarget(value)).filter((value): value is BlueskyTarget => value !== null)
        : [],
    },
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : nowIso(),
  };
}

export function normalizeDiscordTarget(raw: unknown): DiscordTarget | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const name = String(candidate.name ?? "").trim();
  const webhookUrl = String(candidate.webhookUrl ?? "").trim();
  const botToken = String(candidate.botToken ?? "").trim();
  const userToken = String(candidate.userToken ?? "").trim();
  const channelId = String(candidate.channelId ?? "").trim();
  const delivery = normalizeDiscordDelivery(String(candidate.delivery ?? inferDiscordDelivery(webhookUrl, botToken, userToken)).trim());
  if (!name) {
    return null;
  }
  if (delivery === "webhook" && !webhookUrl) {
    return null;
  }
  if (delivery === "bot" && (!botToken || !channelId)) {
    return null;
  }
  if (delivery === "userbot" && (!userToken || !channelId)) {
    return null;
  }
  return {
    id: normalizeTargetKey(String(candidate.id ?? name)),
    name,
    delivery,
    webhookUrl,
    botToken,
    userToken,
    channelId,
    username: String(candidate.username ?? "").trim(),
    avatarUrl: String(candidate.avatarUrl ?? "").trim(),
    proxyUrl: String(candidate.proxyUrl ?? "").trim(),
    headless: normalizeBool(candidate.headless, delivery === "userbot"),
    createdAt: String(candidate.createdAt ?? nowIso()),
    updatedAt: String(candidate.updatedAt ?? nowIso()),
  };
}

function inferDiscordDelivery(webhookUrl: string, botToken: string, userToken: string): DiscordDelivery {
  if (webhookUrl) {
    return "webhook";
  }
  if (userToken) {
    return "userbot";
  }
  return "bot";
}

function normalizeDiscordDelivery(value: string): DiscordDelivery {
  return value === "bot" || value === "userbot" ? value : "webhook";
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeBlueskyTarget(raw: unknown): BlueskyTarget | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const name = String(candidate.name ?? "").trim();
  const identifier = String(candidate.identifier ?? "").trim();
  const appPassword = String(candidate.appPassword ?? "").trim();
  if (!name || !identifier || !appPassword) {
    return null;
  }
  return {
    id: normalizeTargetKey(String(candidate.id ?? name)),
    name,
    identifier,
    appPassword,
    serviceUrl: normalizeServiceUrl(String(candidate.serviceUrl ?? "https://bsky.social")),
    createdAt: String(candidate.createdAt ?? nowIso()),
    updatedAt: String(candidate.updatedAt ?? nowIso()),
  };
}
