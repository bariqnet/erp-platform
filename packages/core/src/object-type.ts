// Metadata object types from RFC §2.2. Each type has an ID prefix the
// resolver uses to pick the right JSON schema at runtime.

import { z } from "zod";

export const ObjectTypeSchema = z.enum([
  "Entity",
  "Field",
  "Relationship",
  "Workflow",
  "View",
  "Automation",
  "Permission",
  "Localization",
]);

export type ObjectType = z.infer<typeof ObjectTypeSchema>;

/**
 * Prefix each ObjectType uses in its `object_id`. Example: an Entity has
 * `object_id: "ent.customer"`, a Workflow has `object_id: "wfl.po_flow"`.
 */
export const OBJECT_TYPE_ID_PREFIX = {
  Entity: "ent",
  Field: "fld",
  Relationship: "rel",
  Workflow: "wfl",
  View: "vw",
  Automation: "aut",
  Permission: "prm",
  Localization: "loc",
} as const satisfies Record<ObjectType, string>;
