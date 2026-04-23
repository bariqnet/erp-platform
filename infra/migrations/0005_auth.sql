-- File: 0005_auth.sql
-- Author: Claude Code
-- Issue: TASK-10.1b · Better Auth integration
-- RFC:   CLAUDE.md §2 (Auth stack) · [ADR-0002](../docs/adr/0002-better-auth-zod-4-deferral.md)
--        · [ADR-0003](../docs/adr/0003-zod-4-migration.md)
--
-- Rollback plan:
--   In dev: `pnpm db:migrate -- --down` reverses the DDL below. In
--   production, Better Auth owns every row in these tables; rollback
--   after pilots are live is performed by point-in-time WAL restore,
--   not the +migrate down block.
--
-- Shape of the change:
--   Creates the `auth` schema and Better Auth's four core tables
--   (user, session, account, verification) with the exact column
--   names Better Auth v1.6.x expects from its Kysely adapter. We
--   use camelCase column names to match Better Auth's default config
--   — overriding them via a custom adapter mapping adds complexity
--   for zero win in a fresh-install codebase.
--
--   The fifth table — `metadata.user_tenant` — is ours. Better Auth
--   has no built-in multi-tenancy; user ⇄ tenant + roles membership
--   lives here. Strict-tenant RLS applies to it. The Better Auth
--   tables themselves are platform-global (a user exists regardless
--   of tenant) and intentionally carry no RLS — access is gated by
--   Better Auth's session endpoints, not by the Postgres role.
--
-- +migrate up

CREATE SCHEMA IF NOT EXISTS auth;

GRANT USAGE ON SCHEMA auth TO erp_app;

-- ── auth.user ───────────────────────────────────────────────────────────
-- Primary user record. id is a string for Better Auth's nanoid-style
-- generator; we use the same shape.
CREATE TABLE auth."user" (
    id               TEXT         PRIMARY KEY,
    name             TEXT,
    email            TEXT         NOT NULL UNIQUE,
    "emailVerified"  BOOLEAN      NOT NULL DEFAULT FALSE,
    image            TEXT,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_user_email ON auth."user" (email);

-- ── auth.session ────────────────────────────────────────────────────────
-- One row per active (or recently-expired) session. Better Auth rotates
-- `token` on refresh; expiresAt drives the cleanup sweep the library
-- runs internally.
CREATE TABLE auth.session (
    id               TEXT         PRIMARY KEY,
    "userId"         TEXT         NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    token            TEXT         NOT NULL UNIQUE,
    "expiresAt"      TIMESTAMPTZ  NOT NULL,
    "ipAddress"      TEXT,
    "userAgent"      TEXT,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_session_user ON auth.session ("userId");
CREATE INDEX idx_auth_session_expires ON auth.session ("expiresAt");

-- ── auth.account ────────────────────────────────────────────────────────
-- Credentials for a user. For email/password auth there's one account
-- with providerId='credential' and a bcrypt hash in `password`. Social
-- providers (Google, GitHub, etc.) populate accessToken + refreshToken;
-- we don't enable them in Phase 1 but the columns are there.
CREATE TABLE auth.account (
    id                       TEXT         PRIMARY KEY,
    "userId"                 TEXT         NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    "accountId"              TEXT         NOT NULL,
    "providerId"             TEXT         NOT NULL,
    "accessToken"            TEXT,
    "refreshToken"           TEXT,
    "idToken"                TEXT,
    "accessTokenExpiresAt"   TIMESTAMPTZ,
    "refreshTokenExpiresAt"  TIMESTAMPTZ,
    scope                    TEXT,
    password                 TEXT,
    "createdAt"              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE ("providerId", "accountId")
);

CREATE INDEX idx_auth_account_user ON auth.account ("userId");

-- ── auth.verification ───────────────────────────────────────────────────
-- Short-lived challenge storage: email-verification tokens, password-
-- reset tokens, magic-link codes. Better Auth sweeps expired rows.
CREATE TABLE auth.verification (
    id            TEXT         PRIMARY KEY,
    identifier    TEXT         NOT NULL,
    value         TEXT         NOT NULL,
    "expiresAt"   TIMESTAMPTZ  NOT NULL,
    "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_verification_identifier ON auth.verification (identifier);
CREATE INDEX idx_auth_verification_expires ON auth.verification ("expiresAt");

-- Better Auth tables are platform-global — NO row-level security on them.
-- Access control is delegated to Better Auth's session endpoints; direct
-- DB reads by app code (via @erp/auth) run without a tenant GUC. The
-- erp_app role gets CRUD so the Fastify adapter can serve login/signup/
-- etc. without escalating privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO erp_app;

-- ── metadata.user_tenant ────────────────────────────────────────────────
-- Multi-tenant authorization mapping. A user can belong to multiple
-- tenants with different roles in each. On login, Better Auth resolves
-- the user; apps/api's auth plugin then looks up the active tenant
-- from this table (matching the requested x-tenant-id or the session's
-- preferred tenant).
--
-- RLS: strict-tenant, same pattern as ops.entity_row. Vendor-level
-- admin tools (if any) run under runAsVendor.
CREATE TABLE metadata.user_tenant (
    user_tenant_pk   BIGSERIAL    PRIMARY KEY,
    user_id          TEXT         NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    tenant_id        TEXT         NOT NULL,
    roles            JSONB        NOT NULL DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (user_id, tenant_id)
);

CREATE INDEX idx_user_tenant_user ON metadata.user_tenant (user_id);

ALTER TABLE metadata.user_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.user_tenant FORCE ROW LEVEL SECURITY;

-- We intentionally allow an "unset tenant" escape hatch (NULL GUC) for
-- the login-time tenant-resolution flow: the auth plugin needs to read
-- every tenant a user belongs to before it can pick one. That read runs
-- under the vendor role (superuser), not via the erp_app RLS path.
CREATE POLICY user_tenant_tenant_isolation ON metadata.user_tenant
    FOR ALL
    TO PUBLIC
    USING (tenant_id = current_setting('app.current_tenant', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.user_tenant TO erp_app;
GRANT USAGE, SELECT ON SEQUENCE metadata.user_tenant_user_tenant_pk_seq TO erp_app;

-- +migrate down

DROP TABLE IF EXISTS metadata.user_tenant;
DROP TABLE IF EXISTS auth.verification;
DROP TABLE IF EXISTS auth.account;
DROP TABLE IF EXISTS auth.session;
DROP TABLE IF EXISTS auth."user";
DROP SCHEMA IF EXISTS auth;
