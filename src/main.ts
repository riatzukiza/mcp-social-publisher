import "dotenv/config";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { PythonImageSandbox, type RenderedSandboxImage } from "./sandbox/pythonImageSandbox.js";
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
const runtimeDir = path.resolve(
  ENV.DATA_DIR ?? (process.env.RENDER === "true" ? "/tmp/mcp-social-publisher" : path.join(process.cwd(), "data")),
);

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
  persistence = new FilePersistence(path.join(runtimeDir, "oauth-store.json"));
  await persistence.init();
  configStore = new ConfigStore(path.join(runtimeDir, "config.json"), {
    initialGitHubUsers: splitList(ENV.INITIAL_GITHUB_ALLOWED_USERS),
  });
}
await configStore.init();

const imageSandbox = new PythonImageSandbox(publicBaseUrl, runtimeDir);
await imageSandbox.init();

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
    imageSandbox: imageSandbox.getStatus(),
  });
});

app.get("/sandbox-images/:fileName", async (req, res) => {
  const image = await imageSandbox.readImage(String(req.params.fileName ?? ""));
  if (!image) {
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type(image.mimeType).send(image.buffer);
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
    serverInstance.registerResource(
      "publisher-image-workflow-guide",
      imageSandbox.getGuideUri(),
      {
        title: "Bluesky Image Workflow Guide",
        description: "Exact workflow for generating matplotlib images and publishing them to Bluesky.",
        mimeType: "text/markdown",
      },
      async () => ({
        contents: [
          {
            uri: imageSandbox.getGuideUri(),
            mimeType: "text/markdown",
            text: imageSandbox.createGuideMarkdown(),
          },
        ],
      }),
    );

    serverInstance.registerResource(
      "publisher-sandbox-image",
      new ResourceTemplate(imageSandbox.getResourceTemplate(), { list: undefined }),
      {
        title: "Generated Sandbox Image",
        description: "Binary image generated by publisher_render_python_image.",
        mimeType: "image/png",
      },
      async (uri, variables) => {
        const fileName = String(variables.fileName ?? "");
        const image = await imageSandbox.readImage(fileName);
        if (!image) {
          throw new Error(`Sandbox image not found: ${fileName}`);
        }
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: image.mimeType,
              blob: image.buffer.toString("base64"),
            },
          ],
        };
      },
    );

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
      "publisher_render_python_image",
      {
        description: "Run minimal matplotlib/numpy Python code and return temporary image URLs for publisher_publish_bluesky.",
        inputSchema: {
          code: z.string().min(1).max(24000).describe("Python plotting code that uses preloaded plt, np, patches, PolarAxes, and optional save_image(name=None, fig=None). Imports are disabled."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ code }): Promise<CallToolResult> => {
        const rendered = await imageSandbox.render(code);
        const imageReferences = rendered.map((image) => ({
          data: image.publicUrl,
          encoding: "url",
          alt: "Describe this image before publishing",
        }));

        return {
          content: [
            {
              type: "text",
              text: [
                "Rendered image sandbox output.",
                "",
                "Use the returned publicUrl values in publisher_publish_bluesky images[].data with encoding set to \"url\".",
                "Or call publisher_render_and_publish_bluesky to render and publish in one step.",
                "",
                JSON.stringify({
                  images: rendered,
                  nextToolExample: {
                    name: "publisher_publish_bluesky",
                    arguments: {
                      target: "default-bluesky",
                      text: "Describe the post here",
                      images: imageReferences,
                    },
                  },
                }, null, 2),
              ].join("\n"),
            },
            {
              type: "resource_link",
              uri: imageSandbox.getGuideUri(),
              name: "Bluesky Image Workflow Guide",
              mimeType: "text/markdown",
              description: "Exact sandbox and publish workflow for Bluesky images.",
            },
            ...toSandboxResourceLinks(rendered),
          ],
        };
      },
    );

    serverInstance.registerTool(
      "publisher_render_and_publish_bluesky",
      {
        description: "Render matplotlib/numpy Python code on the server and publish the resulting images to a configured Bluesky target in one call.",
        inputSchema: {
          target: z.string().min(1).describe("Configured Bluesky target name or id"),
          text: z.string().min(1).max(300).describe("Bluesky post text, up to 300 characters"),
          code: z.string().min(1).max(24000).describe("Python plotting code that uses preloaded plt, np, patches, PolarAxes, and optional save_image(name=None, fig=None). Imports are disabled."),
          imageAlts: z.array(z.string().max(256)).max(4).optional().describe("Optional alt text strings in generated image order."),
          defaultAlt: z.string().max(256).optional().describe("Fallback alt text for any generated image without a matching imageAlts entry."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ target, text, code, imageAlts, defaultAlt }): Promise<CallToolResult> => {
        const binding = await configStore.getBlueskyTarget(target);
        if (!binding) {
          throw new Error(`Unknown Bluesky target: ${target}`);
        }

        const rendered = await imageSandbox.render(code);
        if (rendered.length > 4) {
          throw new Error(`Sandbox generated ${rendered.length} images, but Bluesky supports at most 4 images per post`);
        }

        const images = toSandboxImageInputs(rendered, imageAlts, defaultAlt);
        const publish = await publishBlueskyPost(binding, text, images);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                renderedImages: rendered,
                publish,
              }, null, 2),
            },
            {
              type: "resource_link",
              uri: imageSandbox.getGuideUri(),
              name: "Bluesky Image Workflow Guide",
              mimeType: "text/markdown",
              description: "Exact sandbox and publish workflow for Bluesky images.",
            },
            ...toSandboxResourceLinks(rendered),
          ],
        };
      },
    );

    serverInstance.registerTool(
      "publisher_publish_bluesky",
      {
        description: "Publish a post to a configured Bluesky target. For generated charts, either call publisher_render_python_image first or use publisher_render_and_publish_bluesky for a single-step flow.",
        inputSchema: {
          target: z.string().min(1).describe("Configured Bluesky target name or id"),
          text: z.string().min(1).max(300).describe("Bluesky post text, up to 300 characters"),
          images: z
            .array(
              z.object({
                data: z.string().min(1).describe("Image URL or base64 data. Prefer the publicUrl returned by publisher_render_python_image for large generated images."),
                alt: z.string().max(256).optional().describe("Alt text for accessibility"),
                encoding: z.enum(["base64", "url"]).optional().describe("Encoding: use 'url' for sandbox-generated images, 'base64' only for small inline images."),
              }),
            )
            .max(4)
            .optional()
            .describe("Optional images (up to 4). Best path: call publisher_render_python_image, then reuse its publicUrl values here."),
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
        description: "Publish a message to a configured Discord target using its configured strategy (webhook, bot token, or discord-user-bots user token).",
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

function toSandboxImageInputs(rendered: RenderedSandboxImage[], imageAlts?: string[], defaultAlt?: string): ImageInput[] {
  return rendered.map((image, index) => ({
    data: image.publicUrl,
    encoding: "url",
    alt: imageAlts?.[index] ?? defaultAlt ?? `Generated image ${index + 1}`,
  }));
}

function toSandboxResourceLinks(rendered: RenderedSandboxImage[]): Array<{
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
  description: string;
}> {
  return rendered.map((image) => ({
    type: "resource_link",
    uri: image.resourceUri,
    name: image.fileName,
    mimeType: image.mimeType,
    description: `Generated image. Public URL: ${image.publicUrl}`,
  }));
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1" || normalized.startsWith("127.");
}
