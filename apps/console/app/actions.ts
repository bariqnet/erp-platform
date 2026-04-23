"use server";

import { redirect } from "next/navigation";

import { patchEntityRow, deleteEntityRow, createEntityRow, ApiError } from "../lib/api";
import { clearSessionCookie, readSession, writeSessionCookie, type Session } from "../lib/session";

export interface LoginFormState {
  readonly error: string | null;
}

export async function loginAction(
  _prev: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const tenantId = String(formData.get("tenant_id") ?? "").trim();
  const userId = String(formData.get("user_id") ?? "").trim();
  const rolesRaw = String(formData.get("roles") ?? "").trim();
  const locale = (formData.get("locale") === "ar" ? "ar" : "en") as Session["locale"];

  if (tenantId === "" || userId === "") {
    return { error: "tenant_id and user_id are required" };
  }
  // tenant_id sanity matches the server-side regex (apps/api tenant-context plugin).
  if (!/^t_[a-z0-9_]{2,62}$/.test(tenantId)) {
    return { error: "tenant_id must match t_[a-z0-9_]{2,62}" };
  }

  const session: Session = {
    tenantId,
    userId,
    userRoles: rolesRaw.length > 0 ? rolesRaw.split(",").map((r) => r.trim()) : [],
    locale,
  };
  writeSessionCookie(session);
  redirect("/entities/ent.customer");
}

export async function logoutAction(): Promise<void> {
  clearSessionCookie();
  redirect("/login");
}

export async function setLocaleAction(locale: "en" | "ar"): Promise<void> {
  const current = readSession();
  if (current === null) {
    redirect("/login");
  }
  writeSessionCookie({ ...current, locale });
  redirect("/");
}

export interface PatchRowState {
  readonly error: string | null;
  readonly saved: boolean;
}

export async function patchRowAction(
  entityId: string,
  rowId: string,
  _prev: PatchRowState,
  formData: FormData,
): Promise<PatchRowState> {
  const session = readSession();
  if (session === null) redirect("/login");

  // The form serializes every field into a single hidden `__body__`
  // JSON blob constructed by the client EntityForm — that lets us
  // preserve non-string types (numbers, enums, localized_string
  // objects) without re-parsing form data by type.
  const raw = String(formData.get("__body__") ?? "");
  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: "invalid body shape", saved: false };
  }
  try {
    await patchEntityRow(session, entityId, rowId, patch);
    return { error: null, saved: true };
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: err.detail ?? `API ${err.status}`, saved: false };
    }
    return { error: err instanceof Error ? err.message : "unknown error", saved: false };
  }
}

export async function deleteRowAction(entityId: string, rowId: string): Promise<void> {
  const session = readSession();
  if (session === null) redirect("/login");
  await deleteEntityRow(session, entityId, rowId);
  redirect(`/entities/${entityId}`);
}

export interface CreateRowState {
  readonly error: string | null;
  /** Per-field validation errors surfaced from the API's problem+json errors[]. */
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export async function createRowAction(
  entityId: string,
  _prev: CreateRowState,
  formData: FormData,
): Promise<CreateRowState> {
  const session = readSession();
  if (session === null) redirect("/login");

  // Same hidden __body__ JSON idiom as patchRowAction — the client
  // EntityForm serializes every typed field into one blob so we
  // preserve numbers, enums, localized_string objects across the
  // Server-Action boundary.
  const raw = String(formData.get("__body__") ?? "");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: "invalid body shape", fieldErrors: {} };
  }

  try {
    const created = await createEntityRow(session, entityId, body);
    redirect(`/entities/${encodeURIComponent(entityId)}/${created.row_id}`);
  } catch (err) {
    if (err instanceof ApiError) {
      // apps/api's errors plugin emits problem+json with an `errors[]`
      // array carrying { path, message } per Zod issue. Hoist those
      // into a field → message map the form displays inline.
      const fieldErrors: Record<string, string> = {};
      const errBody = err.body;
      if (
        typeof errBody === "object" &&
        errBody !== null &&
        "errors" in errBody &&
        Array.isArray((errBody as { errors: unknown[] }).errors)
      ) {
        for (const issue of (errBody as { errors: { path?: string; message?: string }[] }).errors) {
          if (typeof issue.path === "string" && typeof issue.message === "string") {
            fieldErrors[issue.path] = issue.message;
          }
        }
      }
      return {
        error: err.detail ?? err.kind ?? `API ${err.status}`,
        fieldErrors,
      };
    }
    // redirect() throws NEXT_REDIRECT — let it propagate.
    throw err;
  }
}
