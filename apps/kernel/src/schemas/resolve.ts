// Zod schemas for the kernel's /internal/resolve endpoint.

import { LayerSchema, ObjectIdSchema } from "@erp/core";
import { z } from "zod";

export const ResolveRequestSchema = z
  .object({
    tenant_id: z.string().regex(/^t_[a-z0-9_]{2,62}$/),
    object_id: ObjectIdSchema,
  })
  .strict();

export const ResolveResponseSchema = z
  .object({
    object_id: ObjectIdSchema,
    body: z.record(z.string(), z.unknown()),
    provenance: z.array(
      z.object({
        layer: LayerSchema,
        version: z.number().int().min(1),
        object_id: z.string(),
      }),
    ),
    cache_status: z.enum(["l1_hit", "l2_hit", "miss"]),
    duration_ms: z.number().nonnegative(),
  })
  .strict();
