import type { BlueskyTarget, DiscordTarget, GitHubOAuthConfig, PublicTargetSummary, ConfigState, DiscordTargetInput } from "./configStore.js";

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
