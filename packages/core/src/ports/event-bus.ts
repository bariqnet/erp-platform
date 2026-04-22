// EventBus port (CLAUDE.md §2 · Events, RFC §10.2 + §14.2).
//
// Phase 1 ships an in-process adapter backed by a Postgres outbox in
// @erp/events (TASK-08). Phase 2+ swaps in a NATS JetStream adapter
// behind the same port. Domain code never touches the bus
// implementation directly — it goes through this interface.
//
// The DomainEvent envelope carries trace context (W3C Trace Context
// per RFC §14.2) and tenant context (every log line and event carries
// tenant_id per CLAUDE.md §9 and RFC §10.2). The Zod schema here is
// the single source of truth for what a "domain event" looks like on
// the wire; payloads are typed per-event by the consumer via the
// `DomainEvent<TPayload>` generic.

import { z } from "zod";

// ── Trace context (W3C Trace Context) ────────────────────────────────

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

export const TraceContextSchema = z
  .object({
    /** 32 lowercase hex characters (128-bit trace id). */
    trace_id: z.string().regex(TRACE_ID_PATTERN),
    /** 16 lowercase hex characters (64-bit span id). */
    span_id: z.string().regex(SPAN_ID_PATTERN),
    /** Two hex chars — trace-flags per W3C (e.g. "01" = sampled). */
    trace_flags: z
      .string()
      .regex(/^[0-9a-f]{2}$/)
      .optional(),
    /** Optional tracestate string per W3C (vendor-specific propagation). */
    trace_state: z.string().optional(),
  })
  .strict();

export type TraceContext = z.infer<typeof TraceContextSchema>;

// ── Domain event envelope ────────────────────────────────────────────

export const DomainEventSchema = z
  .object({
    /** Unique event id — UUID v4. */
    event_id: z.string().uuid(),
    /** Dotted lowercase event name: `metadata.deployed`, `customer.created`. */
    event_type: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
        message: "event_type must match `<segment>.<segment>[.<segment>…]`",
      }),
    /** Starts at 1; bumps on backwards-incompatible payload changes. */
    event_version: z.number().int().min(1),
    /** ISO-8601 UTC timestamp. */
    occurred_at: z.string().datetime(),
    /** Null for vendor-level / platform-wide events. */
    tenant_id: z.string().nullable(),
    /** Who triggered the event (user id, system, ai_specialist, …). Null for
     *  automation-emitted events with no identifiable actor. */
    actor_id: z.string().nullable(),
    /** W3C Trace Context — present when the event was emitted within a
     *  traced request. */
    trace: TraceContextSchema.optional(),
    /** Change Set id if the event was part of a Change Set deploy. */
    change_set_id: z.string().optional(),
    /**
     * Idempotency key. At-least-once delivery means a consumer may see the
     * same event twice; consumers dedup on this. Defaults to `event_id`
     * when omitted; call sites override it when the "same event" spans
     * multiple `event_id`s (e.g. retries of the same Change Set deploy).
     */
    dedup_key: z.string().optional(),
    /** Event-specific payload. Typed per-event via `DomainEvent<TPayload>`. */
    payload: z.unknown(),
  })
  .strict();

/** The raw, untyped DomainEvent. Always prefer the generic form when you
 *  know the payload type. */
export type DomainEventBase = z.infer<typeof DomainEventSchema>;

/**
 * A DomainEvent whose payload is typed as `TPayload`. Mirrors the same
 * `Omit<infer, "payload"> & { payload: T }` pattern used by
 * `UpsertEnvelope<Body>` in envelope.ts.
 */
export type DomainEvent<TPayload = unknown> = Omit<DomainEventBase, "payload"> & {
  payload: TPayload;
};

// ── Subscription + predicate helpers ─────────────────────────────────

/** Handle returned by `subscribe`; callers hold this to unsubscribe later. */
export interface Subscription {
  readonly event_type: string;
  unsubscribe(): void;
}

/** Handler signature for `subscribe`. Returning a Promise is allowed; the
 *  bus awaits it before considering the delivery complete. */
export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
) => Promise<void> | void;

/** Options for `waitFor`. */
export interface WaitForOptions {
  /** Max milliseconds to wait. After this, the returned promise rejects. */
  readonly timeoutMs?: number;
}

// ── The port ─────────────────────────────────────────────────────────

/**
 * A transport-agnostic event bus. Every tenant-scoped caller passes a
 * fully-populated DomainEvent; the bus takes care of delivery.
 *
 * Phase 1 implementation (in-process + Postgres outbox) lives in
 * `@erp/events` and is wired up by each app's server.ts. Later a NATS
 * JetStream adapter implements this same interface.
 */
export interface EventBus {
  /**
   * Publish an event. Adapters MAY buffer; the returned promise resolves
   * when the event has been durably accepted (for the Phase 1 outbox,
   * that means written to the outbox table).
   */
  publish(event: DomainEvent): Promise<void>;

  /**
   * Subscribe to every event whose `event_type` equals `eventType`. Exact
   * match only — no wildcards in Phase 1.
   */
  subscribe<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): Subscription;

  /**
   * Wait for the next event matching `predicate`. Primarily used in tests
   * and during Change Set deploy orchestration where we need to block
   * until a specific event lands (e.g., "metadata.deployed" for the
   * Change Set we just submitted).
   */
  waitFor<TPayload = unknown>(
    predicate: (event: DomainEvent) => boolean,
    options?: WaitForOptions,
  ): Promise<DomainEvent<TPayload>>;
}
