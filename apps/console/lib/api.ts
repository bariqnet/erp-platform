// Thin fetch wrappers for the Admin + Runtime APIs. Server-side only;
// the console never calls the APIs from the browser (auth headers
// would leak into the network tab and the CORS dance isn't worth it
// until Better Auth ships).
//
// All functions take a Session and attach the three dev headers.
// Errors from the API (4xx/5xx problem+json) are surfaced as thrown
// ApiError so callers can match on `.status` in Server Components.

import { authHeaders, type Session } from "./session";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  public readonly status: number;
  public readonly kind: string | undefined;
  public readonly detail: string | undefined;
  public readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : `API ${status}`,
    );
    this.status = status;
    this.body = typeof body === "object" && body !== null && "kind" in body ? body : body;
    this.kind =
      typeof body === "object" && body !== null && "kind" in body
        ? String((body as { kind: unknown }).kind)
        : undefined;
    this.detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : undefined;
  }
}

async function request<T>(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(session),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, parsed);
  }
  return parsed as T;
}

// ── Types (mirror the apps/api Zod schemas) ──────────────────────

export interface MetaObjectRow {
  readonly object_pk: string;
  readonly object_id: string;
  readonly object_type: string;
  readonly layer: string;
  readonly tenant_id: string | null;
  readonly template_id: string | null;
  readonly version: number;
  readonly operation: "upsert" | "tombstone";
  readonly body: Record<string, unknown> | null;
  readonly created_at: string;
  readonly valid_until: string | null;
  readonly change_set_id: string;
}

export interface ResolvedObjectResponse {
  readonly object_id: string;
  readonly body: Record<string, unknown>;
  readonly provenance: readonly { layer: string; version: number; object_id: string }[];
}

export interface EntityRow {
  readonly row_id: string;
  readonly entity_id: string;
  readonly body: Record<string, unknown>;
  readonly status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string | null;
  readonly updated_by: string | null;
}

export interface EntityRowList {
  readonly items: readonly EntityRow[];
  readonly limit: number;
  readonly offset: number;
}

// ── Admin API — metadata ──────────────────────────────────────────

export async function listEntityObjects(session: Session): Promise<readonly MetaObjectRow[]> {
  const res = await request<{ items: readonly MetaObjectRow[] }>(
    session,
    "GET",
    "/admin/v1/metadata/objects?type=Entity",
  );
  return res.items;
}

export async function getResolvedObject(
  session: Session,
  objectId: string,
): Promise<ResolvedObjectResponse> {
  return request<ResolvedObjectResponse>(
    session,
    "GET",
    `/admin/v1/metadata/objects/${encodeURIComponent(objectId)}`,
  );
}

// ── Runtime API ───────────────────────────────────────────────────

export async function listEntityRows(
  session: Session,
  entityId: string,
  params: { readonly limit?: number; readonly offset?: number } = {},
): Promise<EntityRowList> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const suffix = qs.toString().length > 0 ? `?${qs.toString()}` : "";
  return request<EntityRowList>(session, "GET", `/v1/${encodeURIComponent(entityId)}${suffix}`);
}

export async function getEntityRow(
  session: Session,
  entityId: string,
  rowId: string,
): Promise<EntityRow> {
  return request<EntityRow>(session, "GET", `/v1/${encodeURIComponent(entityId)}/${rowId}`);
}

export async function createEntityRow(
  session: Session,
  entityId: string,
  body: Record<string, unknown>,
): Promise<EntityRow> {
  return request<EntityRow>(session, "POST", `/v1/${encodeURIComponent(entityId)}`, body);
}

export async function patchEntityRow(
  session: Session,
  entityId: string,
  rowId: string,
  body: Record<string, unknown>,
): Promise<EntityRow> {
  return request<EntityRow>(session, "PATCH", `/v1/${encodeURIComponent(entityId)}/${rowId}`, body);
}

export async function deleteEntityRow(
  session: Session,
  entityId: string,
  rowId: string,
): Promise<void> {
  await request<{ deleted: true }>(
    session,
    "DELETE",
    `/v1/${encodeURIComponent(entityId)}/${rowId}`,
  );
}
