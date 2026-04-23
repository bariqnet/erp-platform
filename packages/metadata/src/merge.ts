// Four merge strategies (RFC §3.3). Each is a pure function from
// (base, overlay[, keyField]) to a new value. Inputs are never mutated.
//
//   replace             — overlay wins outright.
//   merge_object        — deep-merge. Recursive on nested plain objects;
//                         scalars and arrays are replaced.
//   append              — base and overlay must both be arrays; result is
//                         `[...base, ...overlay]`.
//   merge_list_by_key   — base and overlay are arrays of objects; merged
//                         by entry key; upper overrides matching entries.
//
// The `merge` dispatcher reads the strategy off a LayerCandidate and
// calls the right function. The resolver imports `merge` only; tests
// import each strategy directly to check edge cases.

import type { LayerCandidate } from "@erp/core";

// ── Utilities ─────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Deep clone using the platform's `structuredClone` (Node 17+). Every
 * merge call returns a fresh value; we never mutate the inputs even
 * transitively.
 */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

// ── Strategies ────────────────────────────────────────────────────────

export function applyReplace<T>(_base: T, overlay: T): T {
  return deepClone(overlay);
}

export function applyMergeObject(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = deepClone(v);
  }
  for (const [k, v] of Object.entries(overlay)) {
    const baseV = out[k];
    if (isPlainObject(baseV) && isPlainObject(v)) {
      // Recursive deep-merge on nested plain objects. Arrays + scalars
      // are replaced wholesale per RFC §3.3.
      out[k] = applyMergeObject(baseV, v);
    } else {
      out[k] = deepClone(v);
    }
  }
  return out;
}

export function applyAppend<T>(base: readonly T[], overlay: readonly T[]): T[] {
  return [...base.map(deepClone), ...overlay.map(deepClone)];
}

export function applyMergeListByKey(
  base: readonly Record<string, unknown>[],
  overlay: readonly Record<string, unknown>[],
  keyField: string,
): Record<string, unknown>[] {
  if (!keyField) {
    throw new Error("applyMergeListByKey: keyField is required");
  }

  const out: Record<string, unknown>[] = base.map(deepClone);

  for (const item of overlay) {
    const key = item[keyField];
    if (key === undefined) {
      throw new Error(
        `applyMergeListByKey: overlay item is missing key field "${keyField}"`,
      );
    }
    const idx = out.findIndex((b) => b[keyField] === key);
    if (idx === -1) {
      out.push(deepClone(item));
    } else {
      // Upper overrides matching entries (RFC §3.3).
      out[idx] = deepClone(item);
    }
  }

  return out;
}

// ── Dispatcher ────────────────────────────────────────────────────────

/**
 * Combine `base` with `overlay` according to the candidate's
 * `merge_strategy` (default: `replace`).
 *
 * Throws if the strategy's preconditions are violated (e.g.
 * `append` given a non-array). That is a programmer error — a
 * mis-authored candidate — not a domain failure, and per CLAUDE.md §5
 * those `throw`.
 */
export function merge(
  base: unknown,
  overlay: unknown,
  candidate: LayerCandidate,
): unknown {
  const strategy = candidate.merge_strategy ?? "replace";

  switch (strategy) {
    case "replace":
      return applyReplace(base, overlay);

    case "merge_object": {
      if (!isPlainObject(base) || !isPlainObject(overlay)) {
        throw new Error(
          `merge (merge_object): both base and overlay must be plain objects ` +
            `(at ${candidate.object_id} layer=${candidate.layer})`,
        );
      }
      return applyMergeObject(base, overlay);
    }

    case "append": {
      if (!Array.isArray(base) || !Array.isArray(overlay)) {
        throw new Error(
          `merge (append): both base and overlay must be arrays ` +
            `(at ${candidate.object_id} layer=${candidate.layer})`,
        );
      }
      return applyAppend(base, overlay);
    }

    case "merge_list_by_key": {
      if (!Array.isArray(base) || !Array.isArray(overlay)) {
        throw new Error(
          `merge (merge_list_by_key): both base and overlay must be arrays ` +
            `(at ${candidate.object_id} layer=${candidate.layer})`,
        );
      }
      if (!candidate.key_field) {
        throw new Error(
          `merge (merge_list_by_key): candidate at layer ${candidate.layer} ` +
            `must declare key_field`,
        );
      }
      if (!base.every(isPlainObject) || !overlay.every(isPlainObject)) {
        throw new Error(
          `merge (merge_list_by_key): all items must be plain objects ` +
            `(at ${candidate.object_id} layer=${candidate.layer})`,
        );
      }
      return applyMergeListByKey(
        base as Record<string, unknown>[],
        overlay as Record<string, unknown>[],
        candidate.key_field,
      );
    }
  }
}
