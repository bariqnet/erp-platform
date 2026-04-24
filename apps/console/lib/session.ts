// Session helpers for the console — Better Auth cookie reader
// (TASK-10.1b.2).
//
// The placeholder JSON dev cookie was removed. What lives in the jar
// now is a standard Better Auth signed cookie named
// `erp.session_token` (see packages/auth/src/create-auth.ts).
//
// Design:
//   - The console never validates the cookie itself. It's a bearer
//     token — apps/api's auth plugin resolves it via @erp/auth's
//     resolveSession on every admin+runtime call. So the console's
//     `readSession()` is a synchronous "is there a cookie + a known
//     tenant choice" check for layout rendering + redirect gating;
//     the apps/api side owns the truth.
//   - Tenant choice is kept in a separate cookie `erp.tenant` (HTTP-
//     only, same TTL as the session). A user with multiple tenants
//     can switch by hitting the tenant picker; a user with one
//     tenant never sees the switcher.
//   - Locale stays its own cookie (`erp.locale`) — it's rendered by
//     the root layout before any auth call.

import { cookies } from "next/headers";

const SESSION_COOKIE = "erp.session_token";
const TENANT_COOKIE = "erp.tenant";
const LOCALE_COOKIE = "erp.locale";

export type Locale = "en" | "ar";

export interface Session {
  /** Present when the Better Auth cookie is set. Layout + route
   *  gates check this first before making any Admin-API call. */
  readonly hasSessionCookie: true;
  /** The tenant the user last chose. Empty = ask the picker. */
  readonly tenantId: string;
  /** User-chosen locale. Default en. */
  readonly locale: Locale;
}

export function readSession(): Session | null {
  const jar = cookies();
  const cookie = jar.get(SESSION_COOKIE);
  if (!cookie || cookie.value === "") return null;
  const tenant = jar.get(TENANT_COOKIE)?.value ?? "";
  const locale = (jar.get(LOCALE_COOKIE)?.value ?? "en") as Locale;
  return {
    hasSessionCookie: true,
    tenantId: tenant,
    locale: locale === "ar" ? "ar" : "en",
  };
}

export function writeTenantCookie(tenantId: string): void {
  cookies().set({
    name: TENANT_COOKIE,
    value: tenantId,
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function writeLocaleCookie(locale: Locale): void {
  cookies().set({
    name: LOCALE_COOKIE,
    value: locale,
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function clearAuthCookies(): void {
  cookies().delete(SESSION_COOKIE);
  cookies().delete(TENANT_COOKIE);
}

/**
 * Forward the Better Auth session cookie to the API along with the
 * chosen tenant. The API's auth plugin does the real resolution via
 * resolveSession → resolveTenantContext.
 */
export function authHeaders(session: Session): Record<string, string> {
  // Read the cookie value again here because readSession() returns
  // only the presence bit. The actual signed value needs to reach
  // the API verbatim.
  const jar = cookies();
  const sessionCookie = jar.get(SESSION_COOKIE)?.value ?? "";
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE}=${sessionCookie}`,
  };
  if (session.tenantId !== "") {
    headers["x-tenant-id"] = session.tenantId;
  }
  return headers;
}
