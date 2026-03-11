import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";

import type { Persistence } from "./types.js";

export type ClientInfo = {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
};

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, ClientInfo>();

  public constructor(
    bootstrapClients: readonly ClientInfo[] = [],
    private readonly persistence?: Persistence,
  ) {
    for (const client of bootstrapClients) {
      if (client.client_id) {
        this.clients.set(client.client_id, client);
      }
    }
  }

  public async getClient(clientId: string): Promise<ClientInfo | undefined> {
    const inMemory = this.clients.get(clientId);
    if (inMemory) {
      return inMemory;
    }

    if (!this.persistence) {
      return undefined;
    }

    const persisted = await this.persistence.getClient(clientId);
    if (!persisted) {
      return undefined;
    }

    const hydrated: ClientInfo = {
      client_id: persisted.clientId,
      client_secret: persisted.clientSecret,
      client_name: persisted.clientName,
      redirect_uris: persisted.redirectUris,
      token_endpoint_auth_method: persisted.tokenEndpointAuthMethod,
      grant_types: persisted.grantTypes,
      response_types: persisted.responseTypes,
      client_id_issued_at: persisted.clientIdIssuedAt,
      client_secret_expires_at: persisted.clientSecretExpiresAt,
    };

    this.clients.set(clientId, hydrated);
    return hydrated;
  }

  public async ensurePublicClient(clientId: string, redirectUri: string): Promise<ClientInfo> {
    const existing = await this.getClient(clientId);
    if (existing) {
      if (!existing.redirect_uris.includes(redirectUri) && this.isAutoManagedPublicClient(existing)) {
        const next: ClientInfo = {
          ...existing,
          redirect_uris: [...existing.redirect_uris, redirectUri],
        };
        await this.saveClient(next);
        return next;
      }
      return existing;
    }

    validateRedirectUri(redirectUri);

    const now = Math.floor(Date.now() / 1000);
    const clientInfo: ClientInfo = {
      client_id: clientId,
      client_secret: "",
      client_name: clientId,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: now,
      client_secret_expires_at: 0,
    };

    await this.saveClient(clientInfo);
    return clientInfo;
  }

  public async registerClient(client: Partial<ClientInfo>): Promise<ClientInfo> {
    const clientId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const tokenEndpointAuthMethod = client.token_endpoint_auth_method ?? "none";

    const clientInfo: ClientInfo = {
      client_name: client.client_name ?? "Unknown",
      redirect_uris: client.redirect_uris ?? [],
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      client_secret: tokenEndpointAuthMethod !== "none" ? crypto.randomUUID() : "",
      client_secret_expires_at: 0,
    };

    if (clientInfo.redirect_uris.length === 0) {
      throw new Error("redirect_uris required");
    }
    for (const redirectUri of clientInfo.redirect_uris) {
      validateRedirectUri(redirectUri);
    }
    await this.saveClient(clientInfo);
    return clientInfo;
  }

  private isAutoManagedPublicClient(client: ClientInfo): boolean {
    return client.client_secret.length === 0
      && client.token_endpoint_auth_method === "none"
      && client.client_name === client.client_id;
  }

  private async saveClient(clientInfo: ClientInfo): Promise<void> {
    this.clients.set(clientInfo.client_id, clientInfo);

    if (this.persistence) {
      await this.persistence.setClient(clientInfo.client_id, {
        clientId: clientInfo.client_id,
        clientSecret: clientInfo.client_secret,
        clientName: clientInfo.client_name,
        redirectUris: clientInfo.redirect_uris,
        tokenEndpointAuthMethod: clientInfo.token_endpoint_auth_method,
        grantTypes: clientInfo.grant_types,
        responseTypes: clientInfo.response_types,
        clientIdIssuedAt: clientInfo.client_id_issued_at,
        clientSecretExpiresAt: clientInfo.client_secret_expires_at,
      });
    }
  }
}

function validateRedirectUri(redirectUri: string): void {
  const url = new URL(redirectUri);
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  if (!allowed) {
    throw new Error(`redirect_uri not allowed: ${redirectUri}`);
  }
}
