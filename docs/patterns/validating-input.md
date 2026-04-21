# Pattern — Validating Input

> **Status:** Stub. Populated by **TASK-04** (Zod schemas in
> `@erp/core`) and **TASK-09** (HTTP edge validation).

## Problem

CLAUDE.md §2 (Backend) and §5 (API patterns): Zod is the source of
truth for every schema, every validation, every DTO. One Zod
definition produces runtime validation, the inferred TypeScript
type, and the OpenAPI schema.

CLAUDE.md §0 phrases the underlying rule: never trust the shape of
incoming data. Validate at every boundary you can't compile-time
guarantee — HTTP requests, queue messages, file payloads, third-party
API responses, environment variables.

## When to use Zod

- Every HTTP request (params, query, body, headers).
- Every HTTP response (Zod schema → OpenAPI registration).
- Every queue message handler.
- Every external API client response.
- Every environment-variable read at boot.

## When NOT to use Zod

- Inside a function whose caller is already typed (TypeScript covers
  the contract). Don't double-check; trust the type system internally.

## Skeleton

The schema-first style (`const FooSchema = z.object(...)`,
`type Foo = z.infer<typeof FooSchema>`) is exemplified in TASK-04.
The HTTP-edge wiring with `@asteasolutions/zod-to-openapi` is
exemplified in TASK-09.
