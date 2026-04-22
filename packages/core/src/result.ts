// Result<T, E> — errors-as-values for expected failures.
//
// CLAUDE.md §5: `Result<T, E>` for expected failures (validation,
// not-found, conflict, authorization). Reserve `throw` for truly
// exceptional cases (programming errors, infrastructure outages).
//
// Shape is plain data: `{ ok: true, value }` for success,
// `{ ok: false, error }` for failure. Namespaced helpers live on the
// `Result` object below. No class, no prototype methods — the type
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

// ── Factory + combinators ─────────────────────────────────────────────

function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Apply `f` to the value if `r` is ok; propagate the error unchanged. */
function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/** Apply `f` to the error if `r` is err; propagate the value unchanged. */
function mapErr<T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

/**
 * Apply `f` to the value if `r` is ok; `f` returns another Result which
 * may be either variant. The usual "chain" for composing fallible ops.
 */
function flatMap<T, U, E, F>(
  r: Result<T, E>,
  f: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return r.ok ? f(r.value) : r;
}

/** Exhaustive pattern-match. Returns whichever branch fires. */
function match<T, E, R>(
  r: Result<T, E>,
  handlers: { readonly ok: (value: T) => R; readonly err: (error: E) => R },
): R {
  return r.ok ? handlers.ok(r.value) : handlers.err(r.error);
}

/** Extract the value, or return `fallback` if the Result is err. */
function unwrapOr<T, E, U>(r: Result<T, E>, fallback: U): T | U {
  return r.ok ? r.value : fallback;
}

/** Extract the value, or compute a fallback from the error. */
function unwrapOrElse<T, E, U>(r: Result<T, E>, f: (error: E) => U): T | U {
  return r.ok ? r.value : f(r.error);
}

/**
 * Extract the value. Throws if `r` is err. Reserve for tests and places
 * where an err would be a programmer error (CLAUDE.md §5).
 */
function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`Result.unwrap() called on Err: ${safeStringify(r.error)}`);
}

function safeStringify(e: unknown): string {
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ── Namespace export ──────────────────────────────────────────────────
// Type `Result` and value `Result` share the same name — TS resolves
// them in separate namespaces, so callers can do:
//
//   import { Result } from "@erp/core";
//   type R = Result<number, string>;     // type
//   const r = Result.ok(42);              // value

export const Result = {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  flatMap,
  match,
  unwrap,
  unwrapOr,
  unwrapOrElse,
} as const;
