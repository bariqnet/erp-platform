// TASK-21 · Config Studio v0 — change sets index.

import Link from "next/link";
import { redirect } from "next/navigation";

import { listChangeSets, type ChangeSetSummary } from "../../lib/api";
import { readSession } from "../../lib/session";

interface PageProps {
  readonly searchParams: { readonly status?: string };
}

export default async function ChangeSetsIndexPage(props: PageProps): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");

  const status = props.searchParams.status;
  let items: readonly ChangeSetSummary[] = [];
  let loadError: string | null = null;
  try {
    items = await listChangeSets(session, status !== undefined ? { status } : {});
  } catch (err) {
    loadError = err instanceof Error ? err.message : "load failed";
  }

  const statusFilters = ["draft", "proposed", "approved", "deployed", "rolled_back"] as const;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Change Sets</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Every metadata change moves through a Change Set. The visual editor for drafting them
          lands in Phase 3; for now deploy via the Admin API.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={{ pathname: "/changes" }}
          className={
            status === undefined
              ? "rounded bg-brand-600 px-2 py-1 text-white"
              : "rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-100"
          }
        >
          All
        </Link>
        {statusFilters.map((s) => (
          <Link
            key={s}
            href={{ pathname: "/changes", query: { status: s } }}
            className={
              status === s
                ? "rounded bg-brand-600 px-2 py-1 text-white"
                : "rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-100"
            }
          >
            {s}
          </Link>
        ))}
      </div>

      {loadError !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-slate-500">No change sets match this filter.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Change set</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Operations</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Deployed</th>
                <th className="px-4 py-2 ltr:text-right rtl:text-left" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((cs) => (
                <tr key={cs.change_set_id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <div className="font-mono text-xs text-slate-700">{cs.change_set_id}</div>
                    {cs.description !== null && cs.description !== "" ? (
                      <div className="text-xs text-slate-500">{cs.description}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={cs.status} />
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{cs.operation_count}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500">
                    {new Date(cs.created_at).toLocaleString(session.locale)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500">
                    {cs.deployed_at !== null
                      ? new Date(cs.deployed_at).toLocaleString(session.locale)
                      : "—"}
                  </td>
                  <td className="px-4 py-2 ltr:text-right rtl:text-left">
                    <Link
                      href={{ pathname: `/changes/${encodeURIComponent(cs.change_set_id)}` }}
                      className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
