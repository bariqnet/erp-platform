export { createAuth, type AuthInstance, type CreateAuthInput } from "./create-auth.js";

export {
  resolveSession,
  resolveTenantContext,
  type ResolvedSession,
  type ResolveSessionInput,
  type TenantMembership,
} from "./resolve-session.js";

export {
  createTestSession,
  BETTER_AUTH_COOKIE_NAME,
  type CreateTestSessionInput,
  type TestSession,
} from "./test-session.js";

export { DEV_SECRET, type AuthConfig } from "./config.js";

export { seedUser, type SeedUserInput, type SeedUserResult } from "./seed-user.js";
