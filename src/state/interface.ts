import type { BlueskyTarget, DiscordTarget, GitHubOAuthConfig, PublicTargetSummary, ConfigState } from "./configStore.js";

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
  upsertDiscordTarget(input: {
    name: string;
    webhookUrl: string;
    botToken?: string;
    channelId?: string;
    username?: string;
    avatarUrl?: string;
  }): Promise<void>;
  removeDiscordTarget(nameOrId: string): Promise<void>;
  upsertBlueskyTarget(input: {
    name: string;
    identifier: string;
    appPassword: string;
    serviceUrl: string;
  }): Promise<void>;
  removeBlueskyTarget(nameOrId: string): Promise<void>;
}