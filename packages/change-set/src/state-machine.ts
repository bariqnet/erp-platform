// Change Set state machine (RFC §9.3).
//
//   draft ──(propose)──▶ proposed ──(approve)──▶ approved ──(deploy)──▶ deployed
//     ▲                   │                                          │
//     └─── (revert) ──────┘                                          ▼
//                                                               rolled_back
//
// Transitions have authorization guards: drafting is self-service;
// approval requires `metadata.approve`; deploy requires
// `metadata.deploy`; rollback requires `metadata.deploy` (same role
// so whoever can push can unpush).
//
// This module is PURE — a function from (state, action, actor) to
// either the next state or a structured TransitionError. The actual
// DB writes + audit + event emission live one layer up in
// `@erp/db/ChangeSetRepository`, which calls `transition` first and
// then commits the side effects in a single transaction.

import { Result, type ChangeSetStatus, type Result as ResultT } from "@erp/core";

export type State = ChangeSetStatus;

export type Action = "propose" | "approve" | "deploy" | "rollback" | "revert";

/** The full transition table. States are rows; actions are columns. */
const TRANSITIONS: Readonly<Record<State, Readonly<Partial<Record<Action, State>>>>> = {
  draft: { propose: "proposed" },
  proposed: { approve: "approved", revert: "draft" },
  approved: { deploy: "deployed" },
  deployed: { rollback: "rolled_back" },
  rolled_back: {},
};

/**
 * Role names the guards check against. Kept here as constants so the
 * HTTP layer, the audit layer, and the state machine reference the
 * same strings.
 */
export const REQUIRED_ROLE = {
  propose: "metadata.write",
  approve: "metadata.approve",
  deploy: "metadata.deploy",
  rollback: "metadata.deploy",
  revert: "metadata.write",
} as const satisfies Record<Action, string>;

/** Actor performing a transition. */
export interface TransitionActor {
  readonly actor_id: string;
  readonly roles: readonly string[];
  /** Needed for the "revert must be by the original proposer" guard. */
  readonly draft_author_id?: string | undefined;
}

export type TransitionError =
  | { readonly kind: "invalid_transition"; readonly from: State; readonly action: Action }
  | { readonly kind: "forbidden"; readonly action: Action; readonly required_role: string }
  | { readonly kind: "revert_must_be_by_author"; readonly action: "revert" };

/**
 * Apply an action to the current state. Returns `Result.ok(nextState)`
 * when the transition is valid and the actor has the required role;
 * otherwise a typed `TransitionError`.
 *
 * Pure — no side effects. Callers committing the transition to the DB
 * call this first, then write.
 */
export function transition(
  from: State,
  action: Action,
  actor: TransitionActor,
): ResultT<State, TransitionError> {
  const next = TRANSITIONS[from][action];
  if (next === undefined) {
    return Result.err({ kind: "invalid_transition", from, action });
  }

  const requiredRole = REQUIRED_ROLE[action];
  if (!actor.roles.includes(requiredRole)) {
    return Result.err({ kind: "forbidden", action, required_role: requiredRole });
  }

  // Extra guard on `revert`: only the original drafting actor can walk a
  // proposed Change Set back to draft. Stops a random proposer from
  // un-proposing another author's draft.
  if (action === "revert") {
    if (actor.draft_author_id !== undefined && actor.draft_author_id !== actor.actor_id) {
      return Result.err({ kind: "revert_must_be_by_author", action: "revert" });
    }
  }

  return Result.ok(next);
}

/**
 * Return every action that is legal from `from`, regardless of role.
 * Useful for the Admin API's "what can I do to this Change Set?"
 * endpoint and for UI affordances.
 */
export function allowedActions(from: State): readonly Action[] {
  return Object.keys(TRANSITIONS[from]) as Action[];
}

export const TERMINAL_STATES: readonly State[] = ["rolled_back"];

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}
