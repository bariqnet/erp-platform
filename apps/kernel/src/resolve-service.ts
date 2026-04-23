// ResolveService — the hot path. Given (tenant_id, object_id):
//
//   1. Check L1 → L2 via KernelCache.get.
//   2. On hit, return (cache_status = l1_hit | l2_hit).
//   3. On miss, call @erp/metadata.resolve through the
//      MetadataObjectRepository (which implements MetadataStore),
//      store in both cache tiers, return (cache_status = miss).
//
// Every resolve starts a span (no-op until an OTel SDK registers) and
// logs a structured line with duration_ms + cache_status — the
// latency histogram RFC §14.1 lists.

import { Result, type Result as ResultT } from "@erp/core";
import { type MetadataObjectRepository } from "@erp/db";
import { resolve, type ResolvedObject } from "@erp/metadata";
import { createTracer, type Logger } from "@erp/telemetry";

import { type CacheStatus, type KernelCache } from "./cache.js";

const tracer = createTracer("@erp/kernel");

export interface ResolveInput {
  readonly tenant_id: string;
  readonly object_id: string;
}

export interface ResolveOutput {
  readonly object_id: string;
  readonly body: Record<string, unknown>;
  readonly provenance: readonly { layer: string; version: number; object_id: string }[];
  readonly cache_status: CacheStatus;
  readonly duration_ms: number;
}

export type ResolveError = { readonly kind: "object_not_found"; readonly object_id: string };

export class ResolveService {
  constructor(
    private readonly cache: KernelCache,
    private readonly repo: MetadataObjectRepository,
    private readonly logger: Logger,
  ) {}

  async resolveOne(input: ResolveInput): Promise<ResultT<ResolveOutput, ResolveError>> {
    return tracer.startActiveSpan(
      "kernel.resolve",
      async (span): Promise<ResultT<ResolveOutput, ResolveError>> => {
        const t0 = performance.now();
        span.setAttribute("tenant_id", input.tenant_id);
        span.setAttribute("object_id", input.object_id);

        try {
          // Cache probe
          const hit = await this.cache.get(input.tenant_id, input.object_id);
          if (hit.value !== null) {
            const duration_ms = performance.now() - t0;
            span.setAttribute("cache_status", hit.source);
            span.setAttribute("duration_ms", duration_ms);
            this.logger.info(
              {
                event: "resolve",
                tenant_id: input.tenant_id,
                object_id: input.object_id,
                cache_status: hit.source,
                duration_ms,
              },
              "resolve",
            );
            return Result.ok(toOutput(hit.value, hit.source, duration_ms));
          }

          // Miss — resolve through the store.
          const r = await resolve(
            { tenant_id: input.tenant_id, object_id: input.object_id },
            this.repo,
          );
          if (Result.isErr(r)) {
            const duration_ms = performance.now() - t0;
            span.setAttribute("cache_status", "miss");
            span.setAttribute("duration_ms", duration_ms);
            span.setAttribute("result", "not_found");
            this.logger.info(
              {
                event: "resolve",
                tenant_id: input.tenant_id,
                object_id: input.object_id,
                cache_status: "miss",
                duration_ms,
                result: "not_found",
              },
              "resolve",
            );
            return Result.err({ kind: "object_not_found", object_id: input.object_id });
          }

          await this.cache.set(input.tenant_id, input.object_id, r.value);
          const duration_ms = performance.now() - t0;
          span.setAttribute("cache_status", "miss");
          span.setAttribute("duration_ms", duration_ms);
          this.logger.info(
            {
              event: "resolve",
              tenant_id: input.tenant_id,
              object_id: input.object_id,
              cache_status: "miss",
              duration_ms,
            },
            "resolve",
          );
          return Result.ok(toOutput(r.value, "miss", duration_ms));
        } finally {
          span.end();
        }
      },
    );
  }
}

function toOutput(
  resolved: ResolvedObject,
  cache_status: CacheStatus,
  duration_ms: number,
): ResolveOutput {
  return {
    object_id: resolved.object_id,
    body: resolved.body as Record<string, unknown>,
    provenance: resolved.provenance.map((p) => ({
      layer: p.layer,
      version: p.version,
      object_id: p.object_id,
    })),
    cache_status,
    duration_ms,
  };
}
