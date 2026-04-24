// Shared fixture helpers for every integration test that needs an
// authenticated caller. Thin wrappers over @erp/auth's
// createTestSession — cuts the per-test boilerplate to one
// `const headers = await makeSessionHeaders(...)` line.
//
// Pattern:
//
//   beforeEach(async () => {
//     await freshDb();
//     const auth = createAuth({ db, isProduction: false });
//     proposer = await makeSession(db, auth, {
//       tenantId: TENANT,
//       userId: "u_proposer",
//       roles: ["metadata.write"],
//     });
//     // ... other sessions
//     handle = await buildServer({ db, ... });
//   });
//
//   // in a test:
//   const res = await handle.app.inject({
//     method: "GET",
//     url: "/admin/v1/metadata/objects",
//     headers: sessionHeaders(proposer),
//   });
//
// ADR-0004 §Phasing — every integration test migrates to this path
// during TASK-10.1b.2.

import {
  createTestSession,
  type AuthInstance,
  type CreateTestSessionInput,
  type TestSession,
} from "@erp/auth";
import { type Database } from "@erp/db";
import { type Kysely } from "kysely";

/**
 * Convenience wrapper around `createTestSession` — the only thing it
 * does is let the test file stay terse. Returns the same `TestSession`
 * createTestSession builds.
 */
export async function makeSession(
  db: Kysely<Database>,
  auth: AuthInstance,
  input: CreateTestSessionInput,
): Promise<TestSession> {
  return createTestSession(db, auth, input);
}

/**
 * Build the Fastify `inject({ headers })` shape for a session — cookie
 * + x-tenant-id. Some routes need extra headers (e.g. idempotency
 * keys); callers spread this alongside.
 */
export function sessionHeaders(session: TestSession): {
  cookie: string;
  "x-tenant-id": string;
} {
  return {
    cookie: session.cookieHeader,
    "x-tenant-id": session.tenantId,
  };
}
