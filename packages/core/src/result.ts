// Result<T, E> — errors-as-values for expected failures.
//
// CLAUDE.md §5: `Result<T, E>` for expected failures (validation,
// not-found, conflict, authorization). Reserve `throw` for truly
// exceptional cases (programming errors, infrastructure outages).
//
// Shape is plain data: `{ ok: true, value }` for success,
// `{ ok: false, error }` for failure. Namespaced helpers live in the
// `Result` namespace below. No class, no prototype methods — the type
// is inspectable, JSON-serializable, and has the same shape in every
// runtime. Narrowing works out of the box via `r.ok`.
//
// Usage:
//
//   function loadUser(id: string): Result<User, "not_found" | "forbidden"> {
//     const row = repo.get(id);
//     if (!row) return Result.err("not_found");
//     if (!row.visibleTo(ctx.userId)) return Result.err("forbidden");
//     return Result.ok(row);
//   }
//
//   const out = Result.match(loadUser(id), {
//     ok: (u) => ({ status: 200, body: u }),
//     err: (e) => ({ status: e === "not_found" ? 404 : 403, body: { kind: e } }),
//   });

/** Success variant. `ok: true` is the discriminator. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure variant. `ok: false` is the discriminator. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** A computation that either produced a `T` or failed with an `E`. */
export type Result<T, E> = Ok<T> | Err<E>;

function safeStringify(e: unknown): string {
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ── Namespace-merged helpers ──────────────────────────────────────────
// TS merges a `namespace` declaration with an identically-named `type`,
// so callers import one name and get both:
//
//   import { Result } from "@erp/core";
//   type R = Result<number, string>;     // type
//   const r = Result.ok(42);              // value
//
// `namespace` (vs. an object literal) preserves generic inference on
// `Result.map(r, (n) => n * 2)` — TS 5.x's contextual typing through an
// object property sometimes drops the generics and falls back to
// `unknown`; inside a namespace the function signatures are preserved
// verbatim.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Result {
  // Note on return types: these return `Result<T, never>` / `Result<never, E>`
  // (the widest type still compatible with the runtime shape) rather than
  // `Ok<T>` / `Err<E>`. Assigning an `Err<E>` value to a variable annotated
  // `Result<T, E>` causes TS to narrow the variable to `Err<E>` at use
  // sites, which then fails to infer `T` in `Result.map(r, f)`. Returning
  // `Result<never, E>` is what consumers actually want — they declare
  // `Result<number, string>` and get a usable `T = number` downstream.

  export function ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
  }

  export function err<E>(error: E): Result<never, E> {
    return { ok: false, error };
  }

  export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
    return r.ok;
  }

  export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
    return !r.ok;
  }

  /** Apply `f` to the value if `r` is ok; propagate the error unchanged. */
  export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
    return r.ok ? ok(f(r.value)) : r;
  }

  /** Apply `f` to the error if `r` is err; propagate the value unchanged. */
  export function mapErr<T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> {
    return r.ok ? r : err(f(r.error));
  }

  /**
   * Apply `f` to the value if `r` is ok; `f` returns another Result which
   * may be either variant. The usual "chain" for composing fallible ops.
   */
  export function flatMap<T, U, E, F>(
    r: Result<T, E>,
    f: (value: T) => Result<U, F>,
  ): Result<U, E | F> {
    return r.ok ? f(r.value) : r;
  }

  /** Exhaustive pattern-match. Returns whichever branch fires. */
  export function match<T, E, R>(
    r: Result<T, E>,
    handlers: { readonly ok: (value: T) => R; readonly err: (error: E) => R },
  ): R {
    return r.ok ? handlers.ok(r.value) : handlers.err(r.error);
  }

  /**
   * Extract the value. Throws if `r` is err. Reserve for tests and places
   * where an err would be a programmer error (CLAUDE.md §5).
   */
  export function unwrap<T, E>(r: Result<T, E>): T {
    if (r.ok) return r.value;
    throw new Error(`Result.unwrap() called on Err: ${safeStringify(r.error)}`);
  }

  /** Extract the value, or return `fallback` if the Result is err. */
  export function unwrapOr<T, E, U>(r: Result<T, E>, fallback: U): T | U {
    return r.ok ? r.value : fallback;
  }

  /** Extract the value, or compute a fallback from the error. */
  export function unwrapOrElse<T, E, U>(r: Result<T, E>, f: (error: E) => U): T | U {
    return r.ok ? r.value : f(r.error);
  }
}
