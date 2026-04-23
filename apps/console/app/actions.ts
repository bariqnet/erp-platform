"use server";

import { redirect } from "next/navigation";

import { patchEntityRow, deleteEntityRow, ApiError } from "../lib/api";
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
