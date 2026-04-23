// Convert a meta_outbox SELECT row back into a DomainEvent. Used by the
// pump when it fans rows out to subscribers and by anyone reading the
// outbox directly (admin dashboards, replay tooling).

import { TraceContextSchema, type DomainEvent, type TraceContext } from "@erp/core";
import { type MetaOutboxTable } from "@erp/db";
import { type Selectable } from "kysely";

export function rowToEvent(row: Selectable<MetaOutboxTable>): DomainEvent {
  // Build the event by collecting optional keys into a mutable bag, then
  // freeze into the immutable DomainEvent shape at the return. Keeps the
  // optional-key branches simple without `as unknown as X` bypasses.
  const event: { [k: string]: unknown } = {
    event_id: row.event_id,
    event_type: row.event_type,
    event_version: row.event_version,
    occurred_at: row.occurred_at.toISOString(),
    tenant_id: row.tenant_id,
    actor_id: row.actor_id,
    payload: row.payload,
  };

  if (row.change_set_id !== null) {
    event.change_set_id = row.change_set_id;
  }
  if (row.dedup_key !== row.event_id) {
    event.dedup_key = row.dedup_key;
  }
  if (row.trace !== null) {
    // Validate before promoting — JSONB on the way back is `unknown`
    // until proven otherwise (CLAUDE.md §0: never trust the shape of
    // incoming data).
    const parsed = TraceContextSchema.safeParse(row.trace);
    if (parsed.success) {
      event.trace = parsed.data satisfies TraceContext;
    }
  }

  return event as DomainEvent;
}
