// Response schemas for the kernel's /healthz and /readyz endpoints.
// Same shape as apps/api so operators see a consistent probe body
// across the fleet.

import { z } from "zod";

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string(),
    uptime_seconds: z.number().nonnegative(),
  })
  .strict();

export type Health = z.infer<typeof HealthSchema>;

export const ReadinessSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.record(
      z.string(),
      z.object({
        status: z.enum(["pass", "fail"]),
        latency_ms: z.number().nonnegative().optional(),
        detail: z.string().optional(),
      }),
    ),
  })
  .strict();

export type Readiness = z.infer<typeof ReadinessSchema>;
