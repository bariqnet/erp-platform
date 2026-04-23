// DomainEvent factories for every Change Set transition.
//
// The resolver, the kernel cache, and the outbox pump all subscribe to
// these event types. Keeping the factories here (instead of in each
// service that emits them) means every publisher produces events with
// the same event_type string — a single typo in one place can't split
// subscribers from producers.

import { type DomainEvent } from "@erp/core";

import type { State } from "./state-machine.js";

export const CHANGE_SET_EVENT_TYPES = {
  proposed: "metadata.change_set_proposed",
  approved: "metadata.change_set_approved",
  deployed: "metadata.change_set_deployed",
  rolled_back: "metadata.change_set_rolled_back",
  reverted: "metadata.change_set_reverted",
} as const;

export type ChangeSetEventType =
  (typeof CHANGE_SET_EVENT_TYPES)[keyof typeof CHANGE_SET_EVENT_TYPES];

export interface ChangeSetEventPayload {
  readonly change_set_id: string;
  readonly tenant_id: string;
  readonly from_state: State;
  readonly to_state: State;
  readonly actor_id: string;
  readonly operation_count: number;
}

export interface BuildChangeSetEventInput {
  readonly event_id: string;
  readonly event_type: ChangeSetEventType;
  readonly occurred_at: string;
  readonly change_set_id: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly from_state: State;
  readonly to_state: State;
  readonly operation_count: number;
  readonly change_set_ref?: string;
  readonly dedup_key?: string;
}

/**
 * Build a DomainEvent for a Change Set transition. Callers supply the
 * event_id (UUID v4), occurred_at (ISO 8601), and the trace context is
 * attached by the publisher at the HTTP edge (TASK-09).
 */
export function buildChangeSetEvent(
  input: BuildChangeSetEventInput,
): DomainEvent<ChangeSetEventPayload> {
  const base: DomainEvent<ChangeSetEventPayload> = {
    event_id: input.event_id,
    event_type: input.event_type,
    event_version: 1,
    occurred_at: input.occurred_at,
    tenant_id: input.tenant_id,
    actor_id: input.actor_id,
    change_set_id: input.change_set_ref ?? input.change_set_id,
    dedup_key: input.dedup_key ?? `${input.event_type}:${input.change_set_id}`,
    payload: {
      change_set_id: input.change_set_id,
      tenant_id: input.tenant_id,
      from_state: input.from_state,
      to_state: input.to_state,
      actor_id: input.actor_id,
      operation_count: input.operation_count,
    },
  };
  return base;
}
