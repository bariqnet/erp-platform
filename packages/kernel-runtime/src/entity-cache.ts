// MaterializedEntityCache — in-process LRU keyed on
// (tenant_id, entity_id, version) per RFC §5.3.
//
// Materialization is idempotent + deterministic, so new versions
// produce new cache keys; old keys age out naturally. No explicit
// invalidation needed on the hot path (CLAUDE.md §7 non-negotiable
// #6: "Caches are version-keyed, not invalidation-based on hot paths").
//
// The cache is a simple Map-based LRU — same shape as apps/kernel's
// KernelCache. Phase 1 budget is small (per RFC §12.2: ~1,200
// resolved objects per tenant); we swap in a real LRU package when
// we outgrow 100k entries.

import { type MaterializedEntity } from "./materialize.js";

export interface MaterializedEntityCacheOptions {
  /** Max entries before the oldest is evicted. Default 10_000. */
  readonly maxEntries?: number;
}

export class MaterializedEntityCache {
  private readonly map = new Map<string, MaterializedEntity>();
  private readonly maxEntries: number;

  constructor(options: MaterializedEntityCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /**
   * Look up a materialized entity by (tenant_id, entity_id, version).
   * Version identifies the deployed metadata snapshot — the caller
   * gets it from the resolver's provenance (highest-layer version).
   */
  get(tenantId: string, entityId: string, version: number): MaterializedEntity | undefined {
    const key = this.keyFor(tenantId, entityId, version);
    const hit = this.map.get(key);
    if (hit !== undefined) {
      // LRU touch: move to the end.
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  /** Install a materialized entity under its version-pinned key. */
  set(tenantId: string, entityId: string, version: number, mat: MaterializedEntity): void {
    const key = this.keyFor(tenantId, entityId, version);
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, mat);
  }

  /** Diagnostic — test + observability helper. */
  get size(): number {
    return this.map.size;
  }

  /** Drop every entry. Called from tests; production uses version keys. */
  clear(): void {
    this.map.clear();
  }

  private keyFor(tenantId: string, entityId: string, version: number): string {
    return `${tenantId}::${entityId}::${version}`;
  }
}
