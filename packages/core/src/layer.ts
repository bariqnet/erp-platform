// The five metadata layers from RFC §3.1. Every metadata object carries
// a layer; resolution walks layers bottom-up and merges per strategy.
//
//   L0 · Core             — vendor, bound to platform release
//   L1 · Industry Template — vendor/partner, scoped to tenants subscribed
//   L2 · Tenant Config     — customer-owned per tenant
//   L3 · Tenant Extensions — customer-owned scripting (Phase 3+)
//   L4 · Custom Code       — partner-delivered extensions (Phase 3+)

import { z } from "zod";

export const LayerSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);

export type Layer = z.infer<typeof LayerSchema>;

/** Layers that are always tenant-scoped. L0/L1 are vendor-global. */
export const TENANT_SCOPED_LAYERS: readonly Layer[] = ["L2", "L3", "L4"];

/** Layers that are always vendor-global (tenant_id is null). */
export const VENDOR_GLOBAL_LAYERS: readonly Layer[] = ["L0", "L1"];
