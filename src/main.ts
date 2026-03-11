import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";

import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { FilePersistence } from "./auth/filePersistence.js";
import { PostgresPersistence } from "./auth/postgresPersistence.js";
import { SimpleOAuthProvider } from "./auth/simpleOAuthProvider.js";
import { closeSql, getSql, initSchema } from "./lib/postgres.js";
import { createMcpHttpRouter } from "./lib/mcpHttp.js";
import { createMcpServer } from "./lib/mcpServer.js";
import { publishBlueskyPost, type ImageInput } from "./publishers/bluesky.js";
import { publishDiscordMessage } from "./publishers/discord.js";
import { ConfigStore } from "./state/configStore.js";
import { PostgresConfigStore } from "./state/postgresConfigStore.js";
import type { IConfigStore } from "./state/interface.js";
import { installUi } from "./ui.js";

const ENV = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ISSUER_URL: z.string().url().optional(),
  DATA_DIR: z.string().optional(),
  ADMIN_AUTH_KEY: z.string().min(12),
  INITIAL_GITHUB_ALLOWED_USERS: z.string().optional(),
  AUTO_APPROVE: z.string().optional(),
  ALLOW_UNAUTH_LOCAL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
}).parse(process.env);

const publicBaseUrl = new URL(ENV.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://127.0.0.1:${ENV.PORT}`);
const issuerUrl = new URL(ENV.ISSUER_URL ?? publicBaseUrl.toString());
const resourceServerUrl = new URL("/mcp", publicBaseUrl);

const usePostgres = Boolean(ENV.DATABASE_URL);
let persistence: FilePersistence | PostgresPersistence;
let configStore: IConfigStore;

if (usePostgres) {
  await initSchema();
  persistence = new PostgresPersistence();
  await persistence.init();
  configStore = new PostgresConfigStore({
    initialGitHubUsers: splitList(ENV.INITIAL_GITHUB_ALLOWED_USERS),
  });
} else {
  const dataDir = path.resolve(
    ENV.DATA_DIR ?? (process.env.RENDER === "true" ? "/tmp/mcp-social-publisher" : path.join(process.cwd(), "data")),
  );
  persistence = new FilePersistence(path.join(dataDir, "oauth-store.json"));
  await persistence.init();
  configStore = new ConfigStore(path.join(dataDir, "config.json"), {
    initialGitHubUsers: splitList(ENV.INITIAL_GITHUB_ALLOWED_USERS),
  });
}
await configStore.init();

const oauth = new SimpleOAuthProvider(
  publicBaseUrl,
  toBool(ENV.AUTO_APPROVE, true),
  [
    {
      client_id: "mcp_client_1761003752457_1krtcyb4oxe",
      client_secret: "",
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  ],
  24 * 60 * 60,
  30 * 24 * 60 * 60,
  persistence,
);

const app = express();
const authFormParser = express.urlencoded({ extended: false });
const jsonParser = express.json({ limit: "1mb" });

app.set("trust proxy", true);
app.use(cors({ origin: "*", exposedHeaders: ["mcp-session-id"] }));
app.get("/health", async (_req, res) => {
  const [hasGitHub, snapshot, targets] = await Promise.all([
    configStore.hasGitHubOAuthConfig(),
    configStore.getSnapshot(),
    configStore.getPublicTargets(),
  ]);
  res.json({
    ok: true,
    service: "mcp-social-publisher",
    publicBaseUrl: publicBaseUrl.toString(),
    githubOAuthConfigured: hasGitHub,
    allowlistCount: snapshot.allowedGitHubUsers.length,
    targetCount: targets.length,
    storage: usePostgres ? "postgres" : "file",
  });
});

app.all("/authorize", authFormParser, async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "invalid_request", error_description: "Method not allowed" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");

  const source = req.method === "POST" ? req.body : req.query;
  const clientId = String(source.client_id ?? "").trim();
  let redirectUri = typeof source.redirect_uri === "string" ? source.redirect_uri : undefined;

  if (!clientId) {
    res.status(400).json({ error: "invalid_request", error_description: "client_id is required" });
    return;
  }

  try {
    let client = await oauth.clientsStore.getClient(clientId);

    if (!client) {
      if (!redirectUri) {
        res.status(400).json({ error: "invalid_client", error_description: "Invalid client_id" });
        return;
      }
      client = await oauth.clientsStore.ensurePublicClient(clientId, redirectUri);
    } else if (redirectUri && !client.redirect_uris.includes(redirectUri)) {
      client = await oauth.clientsStore.ensurePublicClient(clientId, redirectUri);
    }

    if (redirectUri) {
      if (!client.redirect_uris.includes(redirectUri)) {
        res.status(400).json({ error: "invalid_request", error_description: "Unregistered redirect_uri" });
        return;
      }
    } else if (client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    } else {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri must be specified when client has multiple registered URIs" });
      return;
    }

    const responseType = String(source.response_type ?? "");
    const codeChallenge = String(source.code_challenge ?? "");
    const codeChallengeMethod = String(source.code_challenge_method ?? "");
    const state = typeof source.state === "string" ? source.state : undefined;
    const scope = typeof source.scope === "string" ? source.scope : "";
    const resourceValue = typeof source.resource === "string" ? source.resource : undefined;

    if (responseType !== "code") {
      res.redirect(302, createAuthorizationErrorRedirect(redirectUri, "invalid_request", "response_type must be code", state));
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      res.redirect(302, createAuthorizationErrorRedirect(redirectUri, "invalid_request", "PKCE S256 is required", state));
      return;
    }

    let resource: URL | undefined;
    if (resourceValue) {
      try {
        resource = new URL(resourceValue);
      } catch {
        res.redirect(302, createAuthorizationErrorRedirect(redirectUri, "invalid_request", "resource must be a valid URL", state));
        return;
      }
    }

    await oauth.authorize(client, {
      state,
      scopes: scope.length > 0 ? scope.split(" ").filter(Boolean) : [],
      redirectUri,
      codeChallenge,
      resource,
    }, res);
  } catch (error) {
    const description = error instanceof Error ? error.message : "Internal Server Error";
    if (redirectUri) {
      res.redirect(302, createAuthorizationErrorRedirect(redirectUri, "invalid_request", description));
      return;
    }
    res.status(400).json({ error: "invalid_client", error_description: description });
  }
});

app.use(mcpAuthRouter({
  provider: oauth,
  issuerUrl,
  baseUrl: publicBaseUrl,
  resourceServerUrl,
  scopesSupported: ["mcp"],
  resourceName: "mcp-social-publisher",
}));

installUi(app, oauth, {
  publicBaseUrl,
  adminAuthKey: ENV.ADMIN_AUTH_KEY,
  configStore,
});

const server = createMcpServer({
  name: "mcp-social-publisher",
  version: "0.1.0",
  register: (serverInstance: McpServer) => {
    serverInstance.registerTool(
      "publisher_list_targets",
      {
        description: "List configured Bluesky and Discord publishing targets",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (): Promise<CallToolResult> => {
        const targets = await configStore.getPublicTargets();
        return { content: [{ type: "text", text: JSON.stringify(targets, null, 2) }] };
      },
    );

    serverInstance.registerTool(
      "publisher_publish_bluesky",
      {
        description: "Publish a post to a configured Bluesky target",
        inputSchema: {
          target: z.string().min(1).describe("Configured Bluesky target name or id"),
          text: z.string().min(1).max(300).describe("Bluesky post text, up to 300 characters"),
          images: z
            .array(
              z.object({
                data: z.string().min(1).describe("Base64-encoded image data or URL"),
                alt: z.string().max(256).optional().describe("Alt text for accessibility"),
                encoding: z.enum(["base64", "url"]).optional().describe("Encoding: base64 (default) or url"),
              }),
            )
            .max(4)
            .optional()
            .describe("Optional images (up to 4), base64 or URL"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ target, text, images }): Promise<CallToolResult> => {
        const binding = await configStore.getBlueskyTarget(target);
        if (!binding) {
          throw new Error(`Unknown Bluesky target: ${target}`);
        }
        const parsedImages: ImageInput[] | undefined = images?.map((img) => ({
          data: img.data,
          alt: img.alt,
          encoding: img.encoding,
        }));
        const result = await publishBlueskyPost(binding, text, parsedImages);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    serverInstance.registerTool(
      "publisher_publish_discord",
      {
        description: "Publish a message to a configured Discord target",
        inputSchema: {
          target: z.string().min(1).describe("Configured Discord target name or id"),
          content: z.string().min(1).max(2000).describe("Discord message content, up to 2000 characters"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ target, content }): Promise<CallToolResult> => {
        const binding = await configStore.getDiscordTarget(target);
        if (!binding) {
          throw new Error(`Unknown Discord target: ${target}`);
        }
        const result = await publishDiscordMessage(binding, content);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  },
});

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
const bearer = requireBearerAuth({
  verifier: oauth,
  requiredScopes: ["mcp"],
  resourceMetadataUrl,
});

const mcpRouter = createMcpHttpRouter({
  createServer: () => server,
});

const maybeBearer: express.RequestHandler = (req, res, next) => {
  if (toBool(ENV.ALLOW_UNAUTH_LOCAL, false) && isLoopbackRequest(req)) {
    next();
    return;
  }
  bearer(req, res, next);
};

app.post("/mcp", jsonParser, maybeBearer, async (req, res) => {
  await mcpRouter.handlePost(req, res);
});

app.get("/mcp", maybeBearer, async (req, res) => {
  await mcpRouter.handleSession(req, res);
});

app.delete("/mcp", maybeBearer, async (req, res) => {
  await mcpRouter.handleSession(req, res);
});

const listener = app.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`[mcp-social-publisher] listening on ${ENV.PORT}`);
  console.log(`[mcp-social-publisher] public base ${publicBaseUrl.toString()}`);
});

const cleanup = async (): Promise<void> => {
  await oauth.stop();
  if (usePostgres) {
    await closeSql();
  }
  listener.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", () => {
  void cleanup();
});

process.on("SIGTERM", () => {
  void cleanup();
});

const entryArg = process.argv[1];
if (!entryArg || import.meta.url !== pathToFileURL(entryArg).href) {
  // module imported for tests
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLoopbackRequest(req: express.Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const forwardedFor = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").toLowerCase();
  const bareHost = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? "";
  return isLoopbackAddress(remote) && (!forwardedFor || isLoopbackAddress(forwardedFor)) && (!bareHost || bareHost === "localhost" || bareHost === "127.0.0.1" || bareHost === "::1");
}

function createAuthorizationErrorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1" || normalized.startsWith("127.");
}
