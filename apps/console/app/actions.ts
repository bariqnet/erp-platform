"use server";

import { redirect } from "next/navigation";

import { patchEntityRow, deleteEntityRow, createEntityRow, ApiError } from "../lib/api";
import {
  clearAuthCookies,
  readSession,
  writeLocaleCookie,
  writeTenantCookie,
  type Locale,
} from "../lib/session";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

export interface LoginFormState {
  readonly error: string | null;
}

/**
 * Login via Better Auth's sign-in endpoint. The console proxies to
 * `POST $API_URL/api/auth/sign-in/email` — the API sets the signed
 * session cookie on its response, and we forward that cookie on to
 * the browser alongside our own tenant cookie.
 */
export async function loginAction(
  _prev: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const tenantId = String(formData.get("tenant_id") ?? "").trim();
  const locale = (formData.get("locale") === "ar" ? "ar" : "en") as Locale;

  if (email === "" || password === "") {
    return { error: "email and password are required" };
  }
  if (tenantId !== "" && !/^t_[a-z0-9_]{2,62}$/.test(tenantId)) {
    return { error: "tenant_id must match t_[a-z0-9_]{2,62}" };
  }

  // Better Auth's CSRF middleware rejects when the Origin header is
  // absent AND the request-host doesn't match baseURL. Node fetch
  // doesn't set Origin by default; we set it explicitly to the
  // console's public URL so Better Auth's trustedOrigins check
  // (configured in @erp/auth) permits the call.
  const consoleOrigin = process.env.CONSOLE_URL ?? "http://localhost:3002";
  const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: consoleOrigin,
    },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = `sign-in failed (${res.status})`;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // non-JSON — keep the generic detail above.
    }
    return { error: detail };
  }

  // Better Auth sets the session cookie on its Set-Cookie header.
  // Forward it to the browser so the session round-trips on the
  // next request.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) {
    const sessionCookie = parseSetCookieForSessionToken(setCookie);
    if (sessionCookie !== null) {
      // Intentional dynamic import: @types is set to DOM for this
      // app, but `cookies()` is a next/headers server-only API. We
      // call it here via the helper that session.ts already
      // exercised. For one-line simplicity we inline the set.
      const { cookies } = await import("next/headers");
      cookies().set({
        name: "erp.session_token",
        value: sessionCookie,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
    }
  }

  writeLocaleCookie(locale);
  if (tenantId !== "") writeTenantCookie(tenantId);

  redirect("/entities/ent.customer");
}

/**
 * Pull the value of `erp.session_token=...` out of a Set-Cookie
 * response header. Browsers parse this automatically; on the
 * server side we do it ourselves.
 */
function parseSetCookieForSessionToken(header: string): string | null {
  for (const rawCookie of header.split(/,(?=[^;]+=[^;]+;)/)) {
    const first = rawCookie.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    if (name === "erp.session_token") return first.slice(eq + 1);
  }
  return null;
}

export async function logoutAction(): Promise<void> {
  // Ask Better Auth to invalidate the session server-side.
  const session = readSession();
  if (session !== null) {
    const { cookies } = await import("next/headers");
    const sessionCookie = cookies().get("erp.session_token")?.value ?? "";
    await fetch(`${API_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: `erp.session_token=${sessionCookie}`,
      },
    }).catch(() => undefined);
  }
  clearAuthCookies();
  redirect("/login");
}

export async function setLocaleAction(locale: "en" | "ar"): Promise<void> {
  if (readSession() === null) redirect("/login");
  writeLocaleCookie(locale);
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
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export async function createRowAction(
  entityId: string,
  _prev: CreateRowState,
  formData: FormData,
): Promise<CreateRowState> {
  const session = readSession();
  if (session === null) redirect("/login");

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
    throw err;
  }
}
