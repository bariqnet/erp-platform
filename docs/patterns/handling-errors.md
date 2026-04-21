# Pattern — Handling Errors

> **Status:** Stub. Populated by **TASK-05** (`Result<T, E>` and the
> `EventBus` port) and **TASK-09** (RFC 7807 error envelope at the
> HTTP edge).

## Problem

CLAUDE.md §5: errors-as-values for expected failures via
`Result<T, E>`. Reserve `throw` for truly exceptional cases
(programming errors, infrastructure outages). At the HTTP edge,
errors are RFC 7807 `application/problem+json` — one format
everywhere.

## When to use what

| Situation | Tool |
|---|---|
| Expected failure (validation, not-found, conflict) | `Result.err(...)` |
| Programming error (invariant violated) | `throw new Error(...)` |
| Infrastructure outage (DB down, Redis unreachable) | Let the framework propagate; surfaced as 503 |
| HTTP response | RFC 7807 problem+json envelope |
| Logging | pino structured event with `tenant_id`, `request_id`, `trace_id` |

## Skeleton

The `Result<T, E>` API (`ok`, `err`, `isOk`, `isErr`, `map`,
`flatMap`, `match`) lands in TASK-05. The RFC 7807 mapping plugin
lands in TASK-09. Until then this stub records the policy.

## Anti-patterns

- Throwing for expected failures (use `Result.err`).
- Returning `null` to mean "not found" (use `Result.err({ kind: "not_found" })`).
- Catching and swallowing without logging.
- Using `any` in the error type (Zod or a discriminated union).
