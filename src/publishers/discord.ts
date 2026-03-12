import { createRequire } from "node:module";

import type { DiscordDelivery, DiscordTarget } from "../state/configStore.js";

type DiscordPublishResult = Record<string, unknown>;

type DiscordPublishStrategy = {
  delivery: DiscordDelivery;
  publish: (target: DiscordTarget, content: string) => Promise<DiscordPublishResult>;
};

type DiscordUserBotsClient = {
  isReady?: boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  close: () => void;
  terminate: () => void;
  login: (token: string) => Promise<boolean>;
  send: (channelId: string, payload: { content: string }) => Promise<Record<string, unknown>>;
};

type DiscordUserBotsModule = {
  Client: new (config?: { headless?: boolean; proxy?: string }) => DiscordUserBotsClient;
};

const require = createRequire(import.meta.url);
const DiscordUserBots = require("discord-user-bots") as DiscordUserBotsModule;

const strategies = new Map<DiscordDelivery, DiscordPublishStrategy>([
  ["bot", { delivery: "bot", publish: publishWithBotToken }],
  ["webhook", { delivery: "webhook", publish: publishWithWebhook }],
  ["userbot", { delivery: "userbot", publish: publishWithUserBot }],
]);

export async function publishDiscordMessage(target: DiscordTarget, content: string): Promise<DiscordPublishResult> {
  const strategy = strategies.get(target.delivery);
  if (!strategy) {
    throw new Error(`Unsupported Discord delivery strategy: ${target.delivery}`);
  }
  return await strategy.publish(target, content);
}

async function publishWithBotToken(target: DiscordTarget, content: string): Promise<DiscordPublishResult> {
  const response = await fetch(`https://discord.com/api/v10/channels/${target.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${target.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord publish failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  return {
    platform: "discord",
    delivery: "bot",
    target: target.name,
    messageId: payload.id,
    channelId: payload.channel_id,
  };
}

async function publishWithWebhook(target: DiscordTarget, content: string): Promise<DiscordPublishResult> {
  const webhookUrl = new URL(target.webhookUrl);
  webhookUrl.searchParams.set("wait", "true");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      ...(target.username ? { username: target.username } : {}),
      ...(target.avatarUrl ? { avatar_url: target.avatarUrl } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord publish failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  return {
    platform: "discord",
    delivery: "webhook",
    target: target.name,
    messageId: payload.id,
    channelId: payload.channel_id,
  };
}

async function publishWithUserBot(target: DiscordTarget, content: string): Promise<DiscordPublishResult> {
  if (!target.userToken || !target.channelId) {
    throw new Error("Discord user-bot target is missing userToken or channelId");
  }

  const client = new DiscordUserBots.Client({
    headless: target.headless,
    ...(target.proxyUrl ? { proxy: target.proxyUrl } : {}),
  });

  try {
    await client.login(target.userToken);
    if (!target.headless) {
      await waitForUserBotReady(client);
    }

    const payload = await client.send(target.channelId, { content });
    return {
      platform: "discord",
      delivery: "userbot",
      target: target.name,
      messageId: payload.id,
      channelId: payload.channel_id ?? target.channelId,
      headless: target.headless,
      proxyConfigured: target.proxyUrl.length > 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Discord user-bot publish failed: ${message}`);
  } finally {
    safelyStopUserBot(client, target.headless);
  }
}

async function waitForUserBotReady(client: DiscordUserBotsClient): Promise<void> {
  if (client.isReady) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Discord user-bot client did not become ready in time"));
    }, 15_000);

    client.on("ready", () => {
      clearTimeout(timeout);
      resolve();
    });

    client.on("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function safelyStopUserBot(client: DiscordUserBotsClient, headless: boolean): void {
  try {
    if (headless) {
      client.terminate();
      return;
    }
    client.close();
  } catch {
    // ignore cleanup failures
  }
}
