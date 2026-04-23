// Kernel cache — L1 in-process + optional L2 Redis.
//
// L1 is a simple Map-based LRU. Phase 1 budget is "small working set"
// (RFC §12.2: ~1,200 resolved objects per tenant, ~4 MB serialized) —
// the O(1)-ish LRU cost of walking a Map on each insert is a
// rounding error next to resolver time. When we need >100k entries,
// swap in a real LRU package.
//
// L2 is ioredis. Optional — when REDIS_URL is absent (tests, local
// dev without the compose stack), the L2 client is null and every
// cache miss goes straight to the store.

import { type ResolvedObject } from "@erp/metadata";
import { type Logger } from "@erp/telemetry";
import { Redis, type RedisOptions } from "ioredis";

// ── Types ────────────────────────────────────────────────────────────

export type CacheStatus = "l1_hit" | "l2_hit" | "miss";

export interface CacheLookupResult {
  readonly value: ResolvedObject | null;
  readonly source: CacheStatus;
}

export interface KernelCacheOptions {
  /** L1 max entries. Defaults to 10_000. */
  readonly l1MaxEntries?: number;
  /** L2 Redis connection URL. When undefined, L2 is disabled. */
  readonly redisUrl?: string;
  /** Logger for cache events. */
  readonly logger: Logger;
  /** L2 key prefix — defaults to "erp:kernel:". */
  readonly redisKeyPrefix?: string;
  /** L2 TTL in seconds. Defaults to 3600 (1h). */
  readonly redisTtlSeconds?: number;
}

// ── Cache class ─────────────────────────────────────────────────────

export class KernelCache {
  private readonly l1: Map<string, ResolvedObject>;
  private readonly l1Max: number;
  // `redis` is nullable *and* mutable — ioredis's connect() can fail
  // asynchronously long after the constructor returns; on that failure
  // we drop to L1-only by setting this to null. `readonly` would block
  // that downgrade.
  private redis: Redis | null;
  private readonly redisKeyPrefix: string;
  private readonly redisTtl: number;
  private readonly logger: Logger;

  constructor(options: KernelCacheOptions) {
    this.l1 = new Map();
    this.l1Max = options.l1MaxEntries ?? 10_000;
    this.redisKeyPrefix = options.redisKeyPrefix ?? "erp:kernel:";
    this.redisTtl = options.redisTtlSeconds ?? 3600;
    this.logger = options.logger;

    if (options.redisUrl !== undefined && options.redisUrl !== "") {
      const opts: RedisOptions = {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      };
      this.redis = new Redis(options.redisUrl, opts);
      this.redis.on("error", (err: Error) => {
        this.logger.warn({ err: err.message }, "kernel cache: Redis error");
      });
      void this.redis.connect().catch((err: unknown) => {
        this.logger.warn({ err }, "kernel cache: Redis connect failed; L2 disabled");
        this.redis = null;
      });
    } else {
      this.redis = null;
    }
  }

  /**
   * Look up `(tenant, object_id)` across L1 then L2. Returns the
   * cached value + the source tier. A null value means "cache miss".
   */
  async get(tenantId: string, objectId: string): Promise<CacheLookupResult> {
    const key = cacheKey(tenantId, objectId);

    // L1
    const l1 = this.l1.get(key);
    if (l1 !== undefined) {
      // Touch — move to end for LRU.
      this.l1.delete(key);
      this.l1.set(key, l1);
      return { value: l1, source: "l1_hit" };
    }

    // L2
    if (this.redis !== null && this.redis.status === "ready") {
      try {
        const raw = await this.redis.get(this.redisKeyPrefix + key);
        if (raw !== null) {
          const parsed = JSON.parse(raw) as ResolvedObject;
          this.fillL1(key, parsed);
          return { value: parsed, source: "l2_hit" };
        }
      } catch (err: unknown) {
        this.logger.warn({ err }, "kernel cache: L2 get failed; falling through to miss");
      }
    }

    return { value: null, source: "miss" };
  }

  /** Store in both tiers. */
  async set(tenantId: string, objectId: string, value: ResolvedObject): Promise<void> {
    const key = cacheKey(tenantId, objectId);
    this.fillL1(key, value);

    if (this.redis !== null && this.redis.status === "ready") {
      try {
        await this.redis.set(this.redisKeyPrefix + key, JSON.stringify(value), "EX", this.redisTtl);
      } catch (err: unknown) {
        this.logger.warn({ err }, "kernel cache: L2 set failed; continuing with L1 only");
      }
    }
  }

  /**
   * Invalidate every entry for a tenant. Called by the cache
   * invalidator on `metadata.change_set_deployed` events — a deploy
   * can touch any object_id in the tenant, so the cheap correct
   * thing is to flush the whole tenant's cache.
   */
  async invalidateTenant(tenantId: string): Promise<number> {
    const prefix = `${tenantId}::`;
    let count = 0;
    for (const k of [...this.l1.keys()]) {
      if (k.startsWith(prefix)) {
        this.l1.delete(k);
        count += 1;
      }
    }
    if (this.redis !== null && this.redis.status === "ready") {
      try {
        const stream = this.redis.scanStream({
          match: `${this.redisKeyPrefix}${prefix}*`,
          count: 100,
        });
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (keys: string[]) => {
            if (keys.length > 0) void this.redis?.del(...keys);
          });
          stream.on("end", () => resolve());
          stream.on("error", reject);
        });
      } catch (err: unknown) {
        this.logger.warn({ err, tenantId }, "kernel cache: L2 tenant invalidate failed");
      }
    }
    return count;
  }

  /** Test helper — returns L1 size. */
  get l1Size(): number {
    return this.l1.size;
  }

  /** Close any connections this cache owns. */
  async close(): Promise<void> {
    if (this.redis !== null) {
      try {
        this.redis.disconnect();
      } catch {
        // no-op
      }
    }
    this.l1.clear();
  }

  private fillL1(key: string, value: ResolvedObject): void {
    // Evict the oldest entry when we hit the cap. Map iteration order
    // is insertion order — the first key is the oldest.
    if (this.l1.size >= this.l1Max) {
      const oldest = this.l1.keys().next().value;
      if (oldest !== undefined) this.l1.delete(oldest);
    }
    this.l1.set(key, value);
  }
}

function cacheKey(tenantId: string, objectId: string): string {
  // tenantId comes first so invalidation can do a prefix sweep.
  return `${tenantId}::${objectId}`;
}
