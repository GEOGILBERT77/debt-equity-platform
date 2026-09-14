import { createClient, SupabaseClient } from "@supabase/supabase-js";

const BUCKET = process.env.SUPABASE_CONTRACTS_BUCKET || "contracts";

/**
 * The document library's actual file storage (v0.47.0) — see Document/DocumentVersion's
 * doc comments in prisma/schema.prisma for why this exists at all (this app used to
 * only ever point at a PandaDoc/DocuSign URL, never store a file itself).
 *
 * WHY A PRIVATE BUCKET, NEVER A STORED PUBLIC URL: these are investors' contracts and
 * agreements — real legal/financial documents. `DocumentVersion.storagePath` is an
 * object KEY, not a URL; nothing in this codebase ever writes a permanent public link
 * to Supabase Storage to the database. Every download mints a short-lived SIGNED url
 * on demand (`createSignedDownloadUrl` below) at the moment someone with entity access
 * actually clicks "download" — see GET /api/documents/:documentId/download, which is
 * the ONLY place this function is called from. A signed URL is deliberately never
 * cached or stored: it expires, and storing it would just recreate the "permanent
 * public link to a private file" problem this design avoids.
 *
 * SETUP (see the README's "Document library & contract analysis" section for the full
 * walkthrough): in the Supabase dashboard, Storage -> New bucket -> name it "contracts"
 * (or set SUPABASE_CONTRACTS_BUCKET to whatever you name it) -> leave "Public" OFF.
 * Then set SUPABASE_URL (Project Settings -> API -> Project URL) and
 * SUPABASE_SERVICE_ROLE_KEY (Project Settings -> API -> service_role secret — NOT the
 * anon/public key, which can't write to a private bucket) as environment variables.
 * The service-role key bypasses Supabase's row-level security, which is exactly why
 * this client is only ever constructed server-side (API routes), never sent to the
 * browser — see every caller of getStorageClient below for confirmation none of them
 * are client components.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as everywhere else touching a live
 * service: there is no network access here to actually verify a real Supabase project
 * against this code. Written carefully against the documented @supabase/supabase-js
 * v2 Storage API; test one real upload/download after deploying.
 */
let cachedClient: SupabaseClient | null = null;

function getStorageClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set to use the document library — see the README's \"Document library & contract analysis\" section."
    );
  }
  if (!cachedClient) {
    // persistSession: false — this client only ever runs server-side, for a single
    // request; there's no browser session for it to persist.
    cachedClient = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }
  return cachedClient;
}

/**
 * Builds the object key a new upload is stored under: `<entityId>/<documentId>/
 * <timestamp>-<sanitized original filename>`. Scoped under entityId first so a bucket
 * listing (or a future per-entity export) is trivial; the documentId segment keeps
 * every version of the same logical document grouped together; the timestamp prefix
 * guarantees two uploads with the same filename never collide.
 */
export function buildStoragePath(entityId: string, documentId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  return `${entityId}/${documentId}/${Date.now()}-${safeName}`;
}

export async function uploadDocumentFile(path: string, bytes: Buffer, mimeType: string): Promise<void> {
  const client = getStorageClient();
  const { error } = await client.storage.from(BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) {
    throw new Error(`Failed to upload "${path}" to Supabase Storage bucket "${BUCKET}": ${error.message}`);
  }
}

export async function createSignedDownloadUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const client = getStorageClient();
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create a signed download URL for "${path}": ${error?.message ?? "no URL returned"}`);
  }
  return data.signedUrl;
}

/**
 * Downloads a file's bytes back out of storage — used by the contract-analysis route
 * to read a previously-uploaded document's content before sending it to the Anthropic
 * API. Not used for user-facing downloads (those go through createSignedDownloadUrl +
 * a redirect instead, so the file is never round-tripped through this server for a
 * human clicking "download").
 */
export async function downloadDocumentFile(path: string): Promise<Buffer> {
  const client = getStorageClient();
  const { data, error } = await client.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new Error(`Failed to download "${path}" from Supabase Storage bucket "${BUCKET}": ${error?.message ?? "no data returned"}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function deleteDocumentFile(path: string): Promise<void> {
  const client = getStorageClient();
  const { error } = await client.storage.from(BUCKET).remove([path]);
  if (error) {
    throw new Error(`Failed to delete "${path}" from Supabase Storage bucket "${BUCKET}": ${error.message}`);
  }
}
