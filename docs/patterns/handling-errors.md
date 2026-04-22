# Pattern — Handling Errors

CLAUDE.md §5: errors-as-values for expected failures via
`Result<T, E>`. Reserve `throw` for truly exceptional cases
(programming errors, infrastructure outages). At the HTTP edge,
errors are RFC 7807 `application/problem+json` — one format
everywhere.

## When to use what

| Situation                                          | Tool                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Expected failure (validation, not-found, conflict) | `Result.err(...)`                                                |
| Programming error (invariant violated)             | `throw new Error(...)`                                           |
| Infrastructure outage (DB down, Redis unreachable) | Let the framework propagate; surfaced as 503                     |
| HTTP response                                      | RFC 7807 problem+json envelope                                   |
| Logging                                            | pino structured event with `tenant_id`, `request_id`, `trace_id` |

## `Result<T, E>` — the canonical shape

Lives in [`packages/core/src/result.ts`](../../packages/core/src/result.ts).
Plain data, not a class. The discriminator is `ok: true | false`:

```ts
interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
type Result<T, E> = Ok<T> | Err<E>;
```

Type `Result` and value `Result` share the same name — TypeScript
puts them in separate namespaces, so one import covers both:

```ts
import { Result } from "@erp/core";

type LoadUser = Result<User, "not_found" | "forbidden">;

function loadUser(id: string, ctx: RequestContext): LoadUser {
  const row = repo.get(id);
  if (!row) return Result.err("not_found");
  if (!row.visibleTo(ctx.userId)) return Result.err("forbidden");
  return Result.ok(row);
}
```

## The combinators

| Method                         | Shape                                    | When                                  |
| ------------------------------ | ---------------------------------------- | ------------------------------------- |
| `Result.ok(v)`                 | `T → Ok<T>`                              | construct a success                   |
| `Result.err(e)`                | `E → Err<E>`                             | construct a failure                   |
| `Result.isOk(r)`               | type guard → `r is Ok<T>`                | narrowing inside a conditional        |
| `Result.isErr(r)`              | type guard → `r is Err<E>`               | same, inverse                         |
| `Result.map(r, f)`             | `(T → U) → Result<U, E>`                 | transform success, pass through error |
| `Result.mapErr(r, f)`          | `(E → F) → Result<T, F>`                 | transform error, pass through success |
| `Result.flatMap(r, f)`         | `(T → Result<U, F>) → Result<U, E \| F>` | chain a fallible step                 |
| `Result.match(r, {ok, err})`   | → `R`                                    | exhaustive pattern-match              |
| `Result.unwrap(r)`             | → `T`, throws on err                     | tests only                            |
| `Result.unwrapOr(r, fallback)` | → `T \| U`                               | safe extraction                       |
| `Result.unwrapOrElse(r, f)`    | → `T \| U`                               | compute fallback from error           |

## Composition — the everyday pattern

Chain two fallible parsers and one pure transform:

```ts
type E = "not_a_number" | "negative";

const parseInt = (s: string): Result<number, E> => {
  const n = Number(s);
  return Number.isFinite(n) ? Result.ok(n) : Result.err("not_a_number");
};

const positive = (n: number): Result<number, E> => (n >= 0 ? Result.ok(n) : Result.err("negative"));

const out = Result.map(
  Result.flatMap(Result.flatMap(Result.ok("42"), parseInt), positive),
  (n) => n * 2,
);
// out = { ok: true, value: 84 }
```

Note: `flatMap`'s return type widens the error union — if the outer
step can fail with `"missing"` and the inner step can fail with
`"not_a_number"`, the composite is `Result<number, "missing" | "not_a_number">`.
TypeScript narrows each branch naturally.

## Converting at the HTTP edge

Every route handler ends in a `Result.match` that maps the two
variants to an HTTP response. The Fastify plugin shipped in TASK-09
will wrap the `err` branch in an RFC 7807 problem+json envelope with
one canonical shape:

```ts
// handler
const result = await service.loadUser(req.params.id, ctx);
return Result.match(result, {
  ok: (user) => reply.send(user),
  err: (kind) => replyProblem(reply, kind),
});

// the plugin (lands in TASK-09 — shape shown here for contract only)
function replyProblem(reply, kind: "not_found" | "forbidden") {
  const map = {
    not_found: { status: 404, title: "Not Found" },
    forbidden: { status: 403, title: "Forbidden" },
  };
  const entry = map[kind];
  return reply
    .code(entry.status)
    .type("application/problem+json")
    .send({
      type: `https://errors.erp.example.com/${kind}`,
      title: entry.title,
      status: entry.status,
    });
}
```

## When to `throw`

Three categories — and only three:

1. **Programming errors.** An invariant you never expect to hit. "We
   cannot compute a hash of the previous audit row that exists by
   construction" — if that's wrong, `throw new Error(...)` so the
   stack trace points at the exact bug.
2. **Infrastructure outages.** The DB returning "connection lost"
   is not a domain outcome. Don't wrap it in `Result.err("db_lost")`
   — let the driver's error propagate; the Fastify error handler
   surfaces it as 503.
3. **Truly unreachable paths.** `default:` on an exhaustive switch
   over a discriminated union with `assertNever(x)`.

Anywhere else, a `throw` means the domain surface leaks exception
handling out to every caller. That's the opposite of what Result
is for.

## Anti-patterns

- **Throwing for expected failures.** `throw new NotFoundError()` —
  use `Result.err("not_found")` instead.
- **Returning `null`/`undefined` to mean "not found".** Forces every
  caller to re-derive what the absence meant. `Result.err({ kind:
"not_found" })` carries the reason.
- **Catching and swallowing.** `try { … } catch {}` is a
  reviewer-blocker; at minimum log the error via the pino logger
  with `tenant_id`, `request_id`, `trace_id`.
- **Using `any` for the error type.** Use a discriminated union
  literal: `"not_found" | "forbidden"` — the exhaustiveness check
  in `Result.match` catches missing branches at compile time.

## Verified by

- [`packages/core/src/result.test.ts`](../../packages/core/src/result.test.ts)
  — 21 tests covering every combinator and a chained-composition
  case.
- TASK-09 will add the RFC 7807 problem+json envelope and the
  `replyProblem` helper shown above.
