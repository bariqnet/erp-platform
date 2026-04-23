// Change Set status — the five states of the RFC §9.3 state machine.
// The full transition table lives in @erp/change-set; this file only
// exports the state set so @erp/db (Kysely types), @erp/change-set
// (state machine), and apps/api (HTTP layer) all reference the same
// strings.

import { z } from "zod";

export const ChangeSetStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "deployed",
  "rolled_back",
]);

export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;
