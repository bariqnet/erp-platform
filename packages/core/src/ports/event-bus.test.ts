import { describe, expect, it } from "vitest";

import {
  DomainEventSchema,
  TraceContextSchema,
  type DomainEvent,
  type EventBus,
  type EventHandler,
  type Subscription,
} from "./event-bus.js";

// ── Trace context ────────────────────────────────────────────────────

describe("TraceContextSchema", () => {
  it("accepts a valid 128-bit trace id + 64-bit span id", () => {
    const tc = {
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      span_id: "b7ad6b7169203331",
      trace_flags: "01",
    };
    expect(TraceContextSchema.parse(tc)).toEqual(tc);
  });

  it("rejects a trace id that is not 32 hex chars", () => {
    expect(() =>
      TraceContextSchema.parse({ trace_id: "abc", span_id: "b7ad6b7169203331" }),
    ).toThrow();
  });

  it("rejects uppercase hex", () => {
    expect(() =>
      TraceContextSchema.parse({
        trace_id: "0AF7651916CD43DD8448EB211C80319C",
        span_id: "b7ad6b7169203331",
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      TraceContextSchema.parse({
        trace_id: "0af7651916cd43dd8448eb211c80319c",
        span_id: "b7ad6b7169203331",
        extra: "nope",
      }),
    ).toThrow();
  });
});

// ── DomainEvent ──────────────────────────────────────────────────────

const EVENT_ID = "b3a5d2c1-0c8c-4a5e-9e2d-6b4c8f7a9d1e";

function makeEvent(override: Partial<DomainEvent> = {}): DomainEvent {
  return {
    event_id: EVENT_ID,
    event_type: "metadata.deployed",
    event_version: 1,
    occurred_at: "2026-04-22T09:30:00.000Z",
    tenant_id: "t_4f8a3c",
    actor_id: "u_7b2f",
    payload: { change_set_id: "cs_9e4a" },
    ...override,
  };
}

describe("DomainEventSchema", () => {
  it("accepts the canonical event shape", () => {
    const e = makeEvent();
    expect(DomainEventSchema.parse(e)).toEqual(e);
  });

  it("allows tenant_id null (vendor-level events)", () => {
    const e = makeEvent({ tenant_id: null });
    expect(DomainEventSchema.parse(e)).toEqual(e);
  });

  it("allows actor_id null (automation-emitted events)", () => {
    const e = makeEvent({ actor_id: null });
    expect(DomainEventSchema.parse(e)).toEqual(e);
  });

  it("accepts an embedded trace context", () => {
    const e = makeEvent({
      trace: {
        trace_id: "0af7651916cd43dd8448eb211c80319c",
        span_id: "b7ad6b7169203331",
      },
    });
    expect(DomainEventSchema.parse(e)).toEqual(e);
  });

  it("accepts a dedup_key for at-least-once delivery", () => {
    const e = makeEvent({ dedup_key: "deploy:cs_9e4a" });
    expect(DomainEventSchema.parse(e)).toEqual(e);
  });

  it.each([
    "Deployed",
    "metadata-deployed",
    "metadata",
    "",
    "metadata..deployed",
  ])("rejects an invalid event_type %s", (bad) => {
    expect(() => DomainEventSchema.parse(makeEvent({ event_type: bad }))).toThrow();
  });

  it("rejects an event_id that is not a UUID", () => {
    expect(() => DomainEventSchema.parse(makeEvent({ event_id: "not-a-uuid" }))).toThrow();
  });

  it("rejects event_version of 0 (starts at 1)", () => {
    expect(() => DomainEventSchema.parse(makeEvent({ event_version: 0 }))).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      DomainEventSchema.parse({ ...makeEvent(), stray: "nope" }),
    ).toThrow();
  });

  it("round-trips through JSON with a typed payload", () => {
    type Payload = { change_set_id: string };
    const e: DomainEvent<Payload> = makeEvent() as DomainEvent<Payload>;
    const raw = DomainEventSchema.parse(JSON.parse(JSON.stringify(e)));
    expect(raw).toEqual(e);
    // Downstream: cast to the typed event once the event_type narrows.
    const typed = raw as DomainEvent<Payload>;
    expect(typed.payload.change_set_id).toBe("cs_9e4a");
  });
});

// ── EventBus interface shape ─────────────────────────────────────────

describe("EventBus interface", () => {
  // Compile-time check — a trivial class satisfies the port. If the
  // interface drifts, this test stops compiling, which is exactly the
  // signal we want.
  class FakeBus implements EventBus {
    published: DomainEvent[] = [];

    async publish(event: DomainEvent): Promise<void> {
      this.published.push(event);
    }

    subscribe<TPayload>(eventType: string, _handler: EventHandler<TPayload>): Subscription {
      return { event_type: eventType, unsubscribe: () => undefined };
    }

    async waitFor<TPayload>(
      predicate: (event: DomainEvent) => boolean,
    ): Promise<DomainEvent<TPayload>> {
      const hit = this.published.find(predicate);
      if (!hit) throw new Error("not found");
      return hit as DomainEvent<TPayload>;
    }
  }

  it("allows an implementation to accept events via publish", async () => {
    const bus = new FakeBus();
    await bus.publish(makeEvent());
    expect(bus.published).toHaveLength(1);
  });

  it("returns a Subscription from subscribe", () => {
    const bus = new FakeBus();
    const sub = bus.subscribe("x.y", () => undefined);
    expect(sub.event_type).toBe("x.y");
    expect(typeof sub.unsubscribe).toBe("function");
  });

  it("waitFor resolves to an event that matches the predicate", async () => {
    const bus = new FakeBus();
    await bus.publish(makeEvent());
    const hit = await bus.waitFor((e) => e.event_type === "metadata.deployed");
    expect(hit.event_id).toBe(EVENT_ID);
  });
});
