# Pattern — Writing a Fastify Route

> **Status:** Stub. Populated by **TASK-09** (Fastify API skeleton).

## Problem

CLAUDE.md §5: routes are thin. Parse input with Zod, call a service,
format output with Zod. Business logic never lives in a route handler.
Every route has a Zod schema registered in OpenAPI; errors are RFC
7807 problem+json; every request has an `x-request-id`.

## When to use

- You are adding a new endpoint under `/admin/v1/*` or `/v1/*`.

## Skeleton

The full skeleton — Fastify plugin shape, Zod schema declaration,
`@asteasolutions/zod-to-openapi` registration, service-call wiring,
error mapping to RFC 7807 — is documented when TASK-09 lands the first
real route. This stub exists so the pattern's location is fixed.

## Verified by

- `scripts/verify.ts` invariant #2 — every route has a Zod schema
  in its options.
- OpenAPI spec at `/docs/openapi.json` includes the route.
