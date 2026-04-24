// TASK-21 · Config Studio v0 — change set detail.
//
// Shows the change set's current state + its staged operations. The
// task doc mentions showing a "before / after" simulate preview; in
// v0 we render the operations as they were staged — the simulate
// endpoint is a POST that we'd expose via a form later (Phase 3
// adds full edit capability).

import Link from "next/link";
import { redirect } from "next/navigation";

import { ApiError, getChangeSet, type ChangeSetDetail } from "../../../lib/api";
import { readSession } from "../../../lib/session";

interface PageProps {
  readonly params: { readonly id: string };
}

export default async function ChangeSetDetailPage(props: PageProps): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");
  const id = decodeURIComponent(props.params.id);

  let cs: ChangeSetDetail | null = null;
  let loadError: string | null = null;
  try {
    cs = await getChangeSet(session, id);
  } catch (err) {
    loadError =
      err instanceof ApiError ? `${err.status} · ${err.detail ?? err.kind ?? ""}` : "load failed";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <Link href="/changes" className="text-slate-500 hover:text-brand-600">
          ← Back to Change Sets
        </Link>
      </div>

      {loadError !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      ) : cs === null ? null : (
        <div className="space-y-4">
          <div className="rounded-lg bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="font-mono text-sm text-slate-500">{cs.change_set_id}</h1>
                <p className="mt-0.5 text-lg font-semibold text-slate-900">
                  {cs.description ?? "(no description)"}
                </p>
              </div>
              <StatusBadge status={cs.status} />
            </div>
            <dl className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
              <Field label="Created">
                <span className="font-mono">
                  {new Date(cs.created_at).toLocaleString(session.locale)}
                </span>{" "}
                by <span className="font-mono text-slate-700">{cs.created_by ?? "—"}</span>
              </Field>
              <Field label="Approved">
                {cs.approved_at !== null ? (
                  <>
                    <span className="font-mono">
                      {new Date(cs.approved_at).toLocaleString(session.locale)}
                    </span>{" "}
                    by <span className="font-mono text-slate-700">{cs.approved_by ?? "—"}</span>
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Field>
              <Field label="Deployed">
                {cs.deployed_at !== null ? (
                  <span className="font-mono">
                    {new Date(cs.deployed_at).toLocaleString(session.locale)}
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Field>
            </dl>
          </div>

          <section className="rounded-lg bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Staged operations
              </h2>
              <span className="text-xs text-slate-400">{cs.operations.length} op(s)</span>
            </div>
            {cs.operations.length === 0 ? (
              <p className="text-sm text-slate-500">No operations staged.</p>
            ) : (
              <ul className="space-y-3">
                {cs.operations.map((op, idx) => (
                  <OperationCard key={idx} op={op} index={idx} />
                ))}
              </ul>
            )}
          </section>

          <details className="rounded-lg bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              Raw JSON
            </summary>
            <pre className="mt-3 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(cs, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-700">{children}</dd>
    </div>
  );
}

function OperationCard({
  op,
  index,
}: {
  readonly op: Record<string, unknown>;
  readonly index: number;
}): JSX.Element {
  const opType = String(op.op ?? "?");
  const objectId = String(op.object_id ?? "?");
  const layer = String(op.layer ?? "?");
  return (
    <li className="rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="inline-flex rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-500">
          #{index + 1}
        </span>
        <span
          className={
            opType === "tombstone"
              ? "inline-flex rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700"
              : "inline-flex rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700"
          }
        >
          {opType}
        </span>
        <span className="font-mono text-xs text-slate-700">{objectId}</span>
        <span className="inline-flex rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-600">
          {layer}
        </span>
      </div>
      {op.body !== undefined ? (
        <pre className="mt-2 overflow-x-auto rounded bg-white p-2 text-xs text-slate-700">
          {JSON.stringify(op.body, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { readonly status: string }): JSX.Element {
  const palette: Record<string, string> = {
    draft: "bg-slate-100 text-slate-700",
    proposed: "bg-blue-100 text-blue-800",
    approved: "bg-purple-100 text-purple-800",
    deployed: "bg-green-100 text-green-800",
    rolled_back: "bg-red-100 text-red-800",
  };
  const cls = palette[status] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>
  );
}
