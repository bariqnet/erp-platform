// Session helpers for the console. The dev auth layer is placeholder —
// CLAUDE.md §2 pins Better Auth but ADR-0002 defers the migration.
// Until TASK-10.1 lands, the console carries the three dev headers
// in a signed cookie the server can read from Server Components.
//
// The cookie format is a JSON payload, not a JWT — no secret to
// leak in dev. Production needs a real session; this file is one of
// the sites that changes when Better Auth lands.

import { cookies } from "next/headers";

export interface Session {
  readonly tenantId: string;
  readonly userId: string;
  readonly userRoles: readonly string[];
  readonly locale: "en" | "ar";
}

const COOKIE_NAME = "erp_dev_session";

/** Read the session from the request's cookie jar. Null = not logged in. */
export function readSession(): Session | null {
  const raw = cookies().get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.tenantId !== "string" ||
      typeof parsed.userId !== "string" ||
      !Array.isArray(parsed.userRoles) ||
      (parsed.locale !== "en" && parsed.locale !== "ar")
    ) {
      return null;
    }
    return {
      tenantId: parsed.tenantId,
      userId: parsed.userId,
      userRoles: parsed.userRoles.filter((r): r is string => typeof r === "string"),
      locale: parsed.locale,
    };
  } catch {
    return null;
  }
}

export function writeSessionCookie(session: Session): void {
  // cookies() in a Server Action or Route Handler returns a jar that
  // exposes .set() / .delete(). Next.js's types at the top level are
  // narrowed to ReadonlyRequestCookies, but the mutation methods are
  // part of the same object — we call them via the one-argument shape
  // the types accept.
  cookies().set({
    name: COOKIE_NAME,
    value: JSON.stringify(session),
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function clearSessionCookie(): void {
  cookies().delete(COOKIE_NAME);
}

/**
 * HTTP headers to attach to every Admin/Runtime API request. Matches
 * the placeholder auth plugin in apps/api.
 */
export function authHeaders(session: Session): Record<string, string> {
  return {
    "x-tenant-id": session.tenantId,
    "x-user-id": session.userId,
    "x-user-roles": session.userRoles.join(", "),
  };
}
