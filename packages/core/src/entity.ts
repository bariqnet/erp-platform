// Entity — the biggest RFC §2.3 type. This is what ships in the `body`
// of a meta_object row when `object_type = 'Entity'`.
//
// An EntityBody describes a Customer, Invoice, Product, etc. — its name,
// label, storage strategy, fields, relationships, lifecycle, indexes,
// permissions baseline, and audit flag.

import { z } from "zod";

import { FieldNameSchema, FieldSchema } from "./field.js";
import { LocalizedStringSchema } from "./localization.js";
import { ObjectIdSchema } from "./object-id.js";
import { RelationshipSchema } from "./relationship.js";

// ── Naming ──────────────────────────────────────────────────────────────

/** Entity name — PascalCase. Matches the JSON Schema in RFC Appendix A. */
export const EntityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Za-z0-9_]*$/, {
    message: "entity name must be PascalCase: [A-Z][A-Za-z0-9_]*",
  });

// ── Storage strategy (RFC §4.2) ────────────────────────────────────────

export const StorageStrategySchema = z.enum(["native", "hybrid", "jsonb", "side_table"]);

export type StorageStrategy = z.infer<typeof StorageStrategySchema>;

export const StorageSchema = z
  .object({
    /** Backing table name. Optional — the kernel picks one if absent. */
    table: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    strategy: StorageStrategySchema,
  })
  .strict();

export type Storage = z.infer<typeof StorageSchema>;

// ── Lifecycle (embedded state-list + optional workflow reference) ──────

/**
 * A single legal transition in the state machine. `action` is optional;
 * when present the Runtime API exposes it as
 * `POST /v1/:entity/:id/actions/<action>`. When absent the transition
 * is driven solely by a `status` change in a PATCH.
 *
 * TASK-15 introduces the transitions array; TASK-16 replaces inline
 * transitions with a full `Workflow` metadata object (`wfl.*`) and
 * adds `guard` + `on_entry_script` + `sla_ms`.
 */
export const LifecycleTransitionSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    action: z.string().min(1).optional(),
  })
  .strict();

export type LifecycleTransition = z.infer<typeof LifecycleTransitionSchema>;

export const LifecycleSchema = z
  .object({
    states: z.array(z.string().min(1)).min(1),
    initial: z.string().min(1),
    workflow_id: ObjectIdSchema.optional(),
    transitions: z.array(LifecycleTransitionSchema).optional(),
  })
  .strict()
  .superRefine((lc, ctx) => {
    if (!lc.states.includes(lc.initial)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initial"],
        message: `initial state "${lc.initial}" must appear in states`,
      });
    }
    if (lc.transitions === undefined) return;
    const stateSet = new Set(lc.states);
    // Action names may repeat across different `from` states — e.g.
    // `start` can move both `open → in_progress` and
    // `reopened → in_progress`. What MUST NOT repeat is a (from,
    // action) pair — that would give one caller-visible route two
    // possible destinations.
    const seenFromAction = new Set<string>();
    for (const [idx, t] of lc.transitions.entries()) {
      if (!stateSet.has(t.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx, "from"],
          message: `transition.from "${t.from}" is not in states`,
        });
      }
      if (!stateSet.has(t.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx, "to"],
          message: `transition.to "${t.to}" is not in states`,
        });
      }
      if (t.action !== undefined) {
        const key = `${t.from}::${t.action}`;
        if (seenFromAction.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["transitions", idx, "action"],
            message: `duplicate (from, action): "${t.from}" + "${t.action}"`,
          });
        }
        seenFromAction.add(key);
      }
    }
  });

export type Lifecycle = z.infer<typeof LifecycleSchema>;

/**
 * Pure helper: look up the legal transition from `currentState` either
 * by an explicit `action` (route-driven) or by a target `toState`
 * (PATCH-driven). Returns the matched transition or `null`.
 *
 * Lives in @erp/core because both the Runtime API service and the
 * console's Actions-button renderer consult it. No I/O; a couple
 * of array scans — performance is irrelevant at typical transition-
 * table sizes (< 20 entries).
 */
export function findLifecycleTransition(
  lifecycle: Lifecycle,
  currentState: string,
  selector: { readonly action: string } | { readonly toState: string },
): LifecycleTransition | null {
  const candidates = lifecycle.transitions ?? [];
  if ("action" in selector) {
    return candidates.find((t) => t.action === selector.action && t.from === currentState) ?? null;
  }
  return candidates.find((t) => t.from === currentState && t.to === selector.toState) ?? null;
}

/**
 * Pure helper: enumerate the transitions legal from `currentState`.
 * The console's entity form uses this to render an Actions button
 * per allowed transition.
 */
export function allowedTransitionsFrom(
  lifecycle: Lifecycle,
  currentState: string,
): readonly LifecycleTransition[] {
  return (lifecycle.transitions ?? []).filter((t) => t.from === currentState);
}

// ── Index definition ───────────────────────────────────────────────────

export const IndexSchema = z
  .object({
    fields: z.array(FieldNameSchema).min(1),
    unique: z.boolean().optional(),
    /** Partial-index predicate, raw SQL. */
    where: z.string().optional(),
  })
  .strict();

export type Index = z.infer<typeof IndexSchema>;

// ── Entity body ────────────────────────────────────────────────────────

export const EntityBodySchema = z
  .object({
    name: EntityNameSchema,
    plural: z.string().min(1).optional(),
    label: LocalizedStringSchema,
    icon: z.string().optional(),
    description: z.string().optional(),
    storage: StorageSchema,
    fields: z.array(FieldSchema).min(1),
    relationships: z.array(RelationshipSchema).optional(),
    lifecycle: LifecycleSchema.optional(),
    indexes: z.array(IndexSchema).optional(),
    permissions_base: ObjectIdSchema.optional(),
    audit: z.boolean().optional(),
  })
  .strict()
  .superRefine((entity, ctx) => {
    // Field names must be unique within an entity.
    const names = entity.fields.map((f) => f.name);
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message: `duplicate field name "${n}"`,
        });
        break;
      }
      seen.add(n);
    }

    // A money field's currency_field must refer to an existing sibling.
    for (const f of entity.fields) {
      if (f.type === "money" && !names.includes(f.currency_field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message:
            `money field "${f.name}" references currency_field "${f.currency_field}" ` +
            `which is not declared on this entity`,
        });
      }
    }
  });

export type EntityBody = z.infer<typeof EntityBodySchema>;
