// Resolved config values shared across the package.

/**
 * Well-known dev secret used when `BETTER_AUTH_SECRET` is absent.
 * Logs a warning on boot so the operator doesn't miss that they
 * need to set the real secret before prod.
 */
export const DEV_SECRET = "dev-only-better-auth-secret-do-not-use-in-production-4d9f2a1e3b7c";

/**
 * The config shape `createAuth` builds internally. Exposed as a type
 * so tests and the Fastify plugin can pass a fully-resolved config
 * forward without re-deriving it.
 */
export interface AuthConfig {
  readonly secret: string;
  readonly baseURL: string;
  readonly cookiePrefix: string;
  readonly isProduction: boolean;
}
