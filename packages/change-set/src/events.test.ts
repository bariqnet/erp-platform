import { DomainEventSchema } from "@erp/core";
import { describe, expect, it } from "vitest";

import { CHANGE_SET_EVENT_TYPES, buildChangeSetEvent } from "./events.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";

describe("CHANGE_SET_EVENT_TYPES", () => {
  it("exposes one event type per terminal transition", () => {
    expect(CHANGE_SET_EVENT_TYPES).toEqual({
      proposed: "metadata.change_set_proposed",
      approved: "metadata.change_set_approved",
      deployed: "metadata.change_set_deployed",
      rolled_back: "metadata.change_set_rolled_back",
      reverted: "metadata.change_set_reverted",
    });
  });

  it.each(Object.values(CHANGE_SET_EVENT_TYPES))(
    "%s is a valid DomainEventSchema event_type",
    (type) => {
      // Parse the full envelope via DomainEventSchema to make sure the
      // event_type regex accepts every string we publish.
      const e = buildChangeSetEvent({
        event_id: EVENT_ID,
        event_type: type,
        occurred_at: "2026-04-23T10:00:00.000Z",
        change_set_id: "cs_1",
        tenant_id: "t_1",
        actor_id: "u_1",
        from_state: "draft",
        to_state: "proposed",
        operation_count: 0,
      });
      expect(() => DomainEventSchema.parse(e)).not.toThrow();
    },
  );
});

describe("buildChangeSetEvent", () => {
  const base = {
    event_id: EVENT_ID,
    event_type: CHANGE_SET_EVENT_TYPES.deployed,
    occurred_at: "2026-04-23T10:00:00.000Z",
    change_set_id: "cs_9e4a",
    tenant_id: "t_4f8a3c",
    actor_id: "u_7b2f",
    from_state: "approved" as const,
    to_state: "deployed" as const,
    operation_count: 3,
  };

  it("produces a DomainEvent with the payload populated", () => {
    const e = buildChangeSetEvent(base);
    expect(e.event_type).toBe("metadata.change_set_deployed");
    expect(e.tenant_id).toBe("t_4f8a3c");
    expect(e.actor_id).toBe("u_7b2f");
    expect(e.change_set_id).toBe("cs_9e4a");
    expect(e.payload).toEqual({
      change_set_id: "cs_9e4a",
      tenant_id: "t_4f8a3c",
      from_state: "approved",
      to_state: "deployed",
      actor_id: "u_7b2f",
      operation_count: 3,
    });
  });

  it("defaults dedup_key to `<event_type>:<change_set_id>`", () => {
    const e = buildChangeSetEvent(base);
    expect(e.dedup_key).toBe("metadata.change_set_deployed:cs_9e4a");
  });

  it("accepts an explicit dedup_key override", () => {
    const e = buildChangeSetEvent({ ...base, dedup_key: "deploy-attempt:42" });
    expect(e.dedup_key).toBe("deploy-attempt:42");
  });

  it("round-trips through DomainEventSchema", () => {
    const e = buildChangeSetEvent(base);
    const parsed = DomainEventSchema.parse(JSON.parse(JSON.stringify(e)));
    expect(parsed).toEqual(e);
  });
});
