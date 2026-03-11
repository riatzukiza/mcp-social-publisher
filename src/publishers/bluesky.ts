import type { BlueskyTarget } from "../state/configStore.js";

type BlueskySession = {
  accessJwt?: string;
  did?: string;
  handle?: string;
};

export type ImageInput = {
  data: string;
  alt?: string;
  encoding?: "base64" | "url";
};

type UploadedBlob = {
  cid: string;
  mimeType: string;
  size: number;
};

async function fetchImageData(input: ImageInput): Promise<{ data: Uint8Array; mimeType: string }> {
  if (input.encoding === "url" || (!input.encoding && input.data.startsWith("http"))) {
    const res = await fetch(input.data);
    if (!res.ok) {
      throw new Error(`Failed to fetch image from URL: ${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = await res.arrayBuffer();
    return { data: new Uint8Array(buffer), mimeType: contentType };
  }
  const mimeType = detectMimeType(input.data);
  const binary = atob(input.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { data: bytes, mimeType };
}

function detectMimeType(base64: string): string {
  const signatures: Array<[string, string]> = [
    ["IVAD", "image/webp"],
    ["/9j/", "image/jpeg"],
    ["iVBORw0KGgo", "image/png"],
    ["R0lGOD", "image/gif"],
  ];
  for (const [sig, mime] of signatures) {
    if (base64.startsWith(sig)) return mime;
  }
  return "image/jpeg";
}

async function uploadBlob(
  serviceUrl: string,
  accessJwt: string,
  imageData: Uint8Array,
  mimeType: string,
): Promise<UploadedBlob> {
  const res = await fetch(`${serviceUrl}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessJwt}`,
      "Content-Type": mimeType,
    },
    body: new Uint8Array(imageData) as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`Blob upload failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { blob?: UploadedBlob };
  if (!json.blob) {
    throw new Error("Blob upload response missing blob field");
  }
  return json.blob;
}

export async function publishBlueskyPost(
  target: BlueskyTarget,
  text: string,
  images?: ImageInput[],
): Promise<Record<string, unknown>> {
  const sessionResponse = await fetch(`${target.serviceUrl}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      identifier: target.identifier,
      password: target.appPassword,
    }),
  });

  if (!sessionResponse.ok) {
    throw new Error(`Bluesky session failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
  }

  const session = (await sessionResponse.json()) as BlueskySession;
  if (!session.accessJwt || !session.did) {
    throw new Error("Bluesky session response was incomplete");
  }

  let embed: Record<string, unknown> | undefined;
  if (images && images.length > 0) {
    const uploadedImages: Array<{ alt: string; image: UploadedBlob }> = [];
    for (const img of images.slice(0, 4)) {
      const { data, mimeType } = await fetchImageData(img);
      const blob = await uploadBlob(target.serviceUrl, session.accessJwt, data, mimeType);
      uploadedImages.push({ alt: img.alt ?? "", image: blob });
    }
    embed = {
      $type: "app.bsky.embed.images",
      images: uploadedImages,
    };
  }

  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
  };
  if (embed) {
    record.embed = embed;
  }

  const publishResponse = await fetch(`${target.serviceUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });

  if (!publishResponse.ok) {
    throw new Error(`Bluesky publish failed: ${publishResponse.status} ${await publishResponse.text()}`);
  }

  const payload = (await publishResponse.json()) as Record<string, unknown>;
  return {
    platform: "bluesky",
    target: target.name,
    handle: session.handle ?? target.identifier,
    uri: payload.uri,
    cid: payload.cid,
    images: images?.length ?? 0,
  };
}
