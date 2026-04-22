// Object-id schema. Every metadata object_id is a dotted lowercase
// identifier with one of the reserved prefixes from RFC §2.2:
//
//   ent.customer            — an Entity
//   fld.customer.tax_id     — a standalone Field definition
//   wfl.po_lifecycle        — a Workflow
//
// Names use `[a-z][a-z0-9_]*` segments; `.` separates segments. The prefix
// is always one of the reserved tokens listed below.

import { z } from "zod";

const PREFIX = "(ent|fld|rel|wfl|vw|aut|prm|loc)";
const SEGMENT = "[a-z][a-z0-9_]*";
const OBJECT_ID_PATTERN = new RegExp(`^${PREFIX}(\\.${SEGMENT})+$`);

export const ObjectIdSchema = z
  .string()
  .min(3)
  .regex(OBJECT_ID_PATTERN, {
    message:
      "object_id must be `<prefix>.<segment>[.<segment>…]` where prefix is one of " +
      "ent|fld|rel|wfl|vw|aut|prm|loc and segments match [a-z][a-z0-9_]*",
  });

export type ObjectId = z.infer<typeof ObjectIdSchema>;
