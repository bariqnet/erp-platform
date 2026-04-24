"use client";

import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";

import { invokeActionAction, type InvokeActionState } from "../../../actions";

const INITIAL: InvokeActionState = { error: null };

/**
 * TASK-15 — Action buttons that drive lifecycle transitions through
 * `POST /v1/:entity/:id/actions/:action`. One form per button so each
 * button carries its own Server Action identity; on success we
 * `router.refresh()` to pick up the new status from the server.
 */
export function ActionsBar({
  entityId,
  rowId,
  actions,
}: {
  readonly entityId: string;
  readonly rowId: string;
  readonly actions: readonly { readonly action: string; readonly to: string }[];
}): JSX.Element | null {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</span>
      {actions.map((a) => (
        <ActionButton key={a.action} entityId={entityId} rowId={rowId} action={a} />
      ))}
    </div>
  );
}

function ActionButton({
  entityId,
  rowId,
  action,
}: {
  readonly entityId: string;
  readonly rowId: string;
  readonly action: { readonly action: string; readonly to: string };
}): JSX.Element {
  const boundAction = invokeActionAction.bind(null, entityId, rowId, action.action);
  const [state, formAction] = useFormState(boundAction, INITIAL);
  const router = useRouter();

  // When the Server Action returns error: null the call succeeded;
  // refresh so the detail page re-renders the new status + the
  // newly-allowed action set.
  if (state.error === null && state !== INITIAL) {
    // useEffect-free refresh — the branch runs once per successful
    // dispatch because React re-renders only when state changes.
    queueMicrotask(() => router.refresh());
  }

  return (
    <form action={formAction} className="inline">
      <Submit label={action.action} detail={`→ ${action.to}`} />
      {state.error !== null ? (
        <span className="ml-2 text-xs text-red-600" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

function Submit({
  label,
  detail,
}: {
  readonly label: string;
  readonly detail: string;
}): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1 rounded border border-brand-300 bg-white px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
    >
      <span>{label}</span>
      <span className="text-[10px] text-slate-400">{detail}</span>
    </button>
  );
}
