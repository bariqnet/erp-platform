import { Result } from "@erp/core";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_ROLE,
  allowedActions,
  isTerminal,
  transition,
  type Action,
  type State,
  type TransitionActor,
} from "./state-machine.js";

function actor(roles: readonly string[], overrides: Partial<TransitionActor> = {}): TransitionActor {
  return { actor_id: "u_1", roles, ...overrides };
}

describe("transition — happy path through the full lifecycle", () => {
  it("draft → proposed → approved → deployed → rolled_back", () => {
    const proposer = actor(["metadata.write"]);
    const approver = actor(["metadata.approve"]);
    const deployer = actor(["metadata.deploy"]);

    const t1 = transition("draft", "propose", proposer);
    expect(t1.ok && t1.value).toBe("proposed");

    const t2 = transition("proposed", "approve", approver);
    expect(t2.ok && t2.value).toBe("approved");

    const t3 = transition("approved", "deploy", deployer);
    expect(t3.ok && t3.value).toBe("deployed");

    const t4 = transition("deployed", "rollback", deployer);
    expect(t4.ok && t4.value).toBe("rolled_back");
  });

  it("proposed can revert to draft (same author)", () => {
    const a = actor(["metadata.write"], { draft_author_id: "u_1" });
    const r = transition("proposed", "revert", a);
    expect(r.ok && r.value).toBe("draft");
  });
});

// ── Invalid transitions ─────────────────────────────────────────────

describe("transition — invalid_transition errors", () => {
  const everyAction: readonly Action[] = ["propose", "approve", "deploy", "rollback", "revert"];
  const everyState: readonly State[] = ["draft", "proposed", "approved", "deployed", "rolled_back"];

  const legal: ReadonlyMap<State, readonly Action[]> = new Map([
    ["draft", ["propose"]],
    ["proposed", ["approve", "revert"]],
    ["approved", ["deploy"]],
    ["deployed", ["rollback"]],
    ["rolled_back", []],
  ]);

  for (const from of everyState) {
    for (const action of everyAction) {
      const allowed = legal.get(from)!.includes(action);
      if (allowed) continue;
      it(`rejects ${from} --(${action})-->  `, () => {
        const r = transition(from, action, actor(["metadata.write", "metadata.approve", "metadata.deploy"]));
        expect(Result.isErr(r)).toBe(true);
        if (Result.isErr(r)) {
          expect(r.error.kind).toBe("invalid_transition");
        }
      });
    }
  }
});

// ── Authorization ───────────────────────────────────────────────────

describe("transition — authorization", () => {
  it.each([
    ["propose", "draft", "metadata.write"],
    ["approve", "proposed", "metadata.approve"],
    ["deploy", "approved", "metadata.deploy"],
    ["rollback", "deployed", "metadata.deploy"],
    ["revert", "proposed", "metadata.write"],
  ] as const)("%s requires %s", (action, from, role) => {
    expect(REQUIRED_ROLE[action]).toBe(role);

    const noRole = transition(from, action, actor([]));
    expect(Result.isErr(noRole)).toBe(true);
    if (Result.isErr(noRole)) {
      expect(noRole.error.kind).toBe("forbidden");
      if (noRole.error.kind === "forbidden") {
        expect(noRole.error.required_role).toBe(role);
      }
    }

    const withRole = transition(
      from,
      action,
      actor([role], action === "revert" ? { draft_author_id: "u_1" } : {}),
    );
    expect(Result.isOk(withRole)).toBe(true);
  });

  it("revert refuses a non-author even with metadata.write", () => {
    const r = transition(
      "proposed",
      "revert",
      actor(["metadata.write"], { actor_id: "u_bob", draft_author_id: "u_alice" }),
    );
    expect(Result.isErr(r)).toBe(true);
    if (Result.isErr(r)) {
      expect(r.error.kind).toBe("revert_must_be_by_author");
    }
  });

  it("revert without a draft_author_id on the actor permits the transition", () => {
    // When draft_author_id is absent (e.g. legacy Change Set from an
    // actor-less migration), the author-match guard is skipped.
    const r = transition("proposed", "revert", actor(["metadata.write"]));
    expect(Result.isOk(r)).toBe(true);
  });
});

// ── allowedActions / isTerminal ─────────────────────────────────────

describe("allowedActions", () => {
  it.each([
    ["draft", ["propose"]],
    ["proposed", ["approve", "revert"]],
    ["approved", ["deploy"]],
    ["deployed", ["rollback"]],
    ["rolled_back", []],
  ] as const)("returns the right actions for %s", (state, expected) => {
    expect([...allowedActions(state)].sort()).toEqual([...expected].sort());
  });
});

describe("isTerminal", () => {
  it("rolled_back is terminal; every other state is not", () => {
    expect(isTerminal("rolled_back")).toBe(true);
    expect(isTerminal("draft")).toBe(false);
    expect(isTerminal("proposed")).toBe(false);
    expect(isTerminal("approved")).toBe(false);
    expect(isTerminal("deployed")).toBe(false);
  });
});
