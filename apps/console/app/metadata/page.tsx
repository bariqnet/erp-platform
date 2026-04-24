// TASK-21 · Config Studio v0 — metadata object list.
//
// Read-only index of every metadata object the tenant sees: vendor L0
// rows + any L1 overlay currently active + the tenant's own L2
// customizations. Grouped by type (Entity / Permission / Localization /
// Relationship), sorted alphabetically within each group.

import Link from "next/link";
import { redirect } from "next/navigation";

import { listMetadataObjects, type MetaObjectRow } from "../../lib/api";
import { readSession } from "../../lib/session";

export default async function MetadataIndexPage(): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");

  let objects: readonly MetaObjectRow[] = [];
  let loadError: string | null = null;
  try {
    objects = await listMetadataObjects(session);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "load failed";
  }

  const grouped = groupBy(objects, (o) => o.object_type);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Configuration Studio</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Read-only view of resolved metadata. Deploy via the Change Set API (Phase 3 adds the
          visual editor).
        </p>
      </div>

      {loadError !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      ) : objects.length === 0 ? (
        <div className="rounded-lg bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-slate-500">No metadata objects are deployed yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([type, rows]) => (
              <section key={type} className="overflow-hidden rounded-lg bg-white shadow-sm">
                <header className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {type} <span className="font-normal text-slate-400">({rows.length})</span>
                </header>
                <table className="w-full text-sm">
                  <thead className="bg-white text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Object id</th>
                      <th className="px-4 py-2">Layer</th>
                      <th className="px-4 py-2">Version</th>
                      <th className="px-4 py-2">Change set</th>
                      <th className="px-4 py-2 ltr:text-right rtl:text-left" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {[...rows]
                      .sort((a, b) => a.object_id.localeCompare(b.object_id))
                      .map((row) => (
                        <tr key={`${row.object_id}-${row.layer}`} className="hover:bg-slate-50">
                          <td className="px-4 py-2 font-mono text-xs text-slate-700">
                            {row.object_id}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            <LayerBadge layer={row.layer} />
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500">v{row.version}</td>
                          <td className="px-4 py-2 font-mono text-xs text-slate-500">
                            {row.change_set_id.slice(0, 16)}…
                          </td>
                          <td className="px-4 py-2 ltr:text-right rtl:text-left">
                            <Link
                              href={{ pathname: `/metadata/${encodeURIComponent(row.object_id)}` }}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                            >
                              Resolved
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Record<string, readonly T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const k = key(r);
    if (!out[k]) out[k] = [];
    out[k].push(r);
  }
  return out;
}

function LayerBadge({ layer }: { readonly layer: string }): JSX.Element {
  const palette: Record<string, string> = {
    L0: "bg-slate-100 text-slate-700",
    L1: "bg-amber-100 text-amber-800",
    L2: "bg-emerald-100 text-emerald-800",
    L3: "bg-indigo-100 text-indigo-700",
    L4: "bg-fuchsia-100 text-fuchsia-700",
  };
  const cls = palette[layer] ?? "bg-slate-100 text-slate-700";
  return <span className={`inline-flex rounded px-1.5 py-0.5 font-mono ${cls}`}>{layer}</span>;
}
