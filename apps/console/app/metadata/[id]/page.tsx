// TASK-21 · Config Studio v0 — resolved view with per-field provenance.
//
// Shows the merged body from @erp/metadata's `resolve()` plus an
// indication of which layer each top-level body field came from. The
// provenance array from the Admin API only reports the *highest*
// contributing layer per object (not per field), so this page
// approximates per-field provenance by diffing the layers' bodies.
// That approximation is fine for v0 — v1 (Phase 3) will expose
// per-field provenance server-side.

import Link from "next/link";
import { redirect } from "next/navigation";

import {
  ApiError,
  getObjectHistory,
  getResolvedObject,
  type MetaObjectRow,
  type ResolvedObjectResponse,
} from "../../../lib/api";
import { readSession } from "../../../lib/session";

interface PageProps {
  readonly params: { readonly id: string };
}

export default async function ResolvedMetadataPage(props: PageProps): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");
  const objectId = decodeURIComponent(props.params.id);

  let resolved: ResolvedObjectResponse | null = null;
  let history: readonly MetaObjectRow[] = [];
  let loadError: string | null = null;
  try {
    const [r, h] = await Promise.all([
      getResolvedObject(session, objectId),
      getObjectHistory(session, objectId),
    ]);
    resolved = r;
    history = h.items;
  } catch (err) {
    loadError =
      err instanceof ApiError ? `${err.status} · ${err.detail ?? err.kind ?? ""}` : "load failed";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <Link href="/metadata" className="text-slate-500 hover:text-brand-600">
          ← Back to Configuration Studio
        </Link>
      </div>

      <div>
        <h1 className="font-mono text-sm text-slate-500">{objectId}</h1>
        <p className="mt-0.5 text-lg font-semibold text-slate-900">Resolved metadata</p>
      </div>

      {loadError !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      ) : resolved === null ? null : (
        <div className="space-y-4">
          <section className="rounded-lg bg-white p-4 shadow-sm">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Provenance stack
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {resolved.provenance.map((p) => (
                <span
                  key={`${p.layer}-${p.version}`}
                  className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-mono"
                >
                  <span className="font-semibold">{p.layer}</span>
                  <span className="text-slate-400">v{p.version}</span>
                </span>
              ))}
              {resolved.provenance.length > 1 ? (
                <span className="text-slate-400">
                  (fields from higher layers override lower ones)
                </span>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg bg-white p-4 shadow-sm">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Resolved body
            </h2>
            <BodyWithProvenance body={resolved.body} history={history} />
          </section>

          <details className="rounded-lg bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              Raw resolved JSON
            </summary>
            <pre className="mt-3 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(resolved.body, null, 2)}
            </pre>
          </details>

          <section className="rounded-lg bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Version history
              </h2>
              <span className="text-xs text-slate-400">{history.length} row(s)</span>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">No history rows.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-1">Layer</th>
                    <th className="px-2 py-1">Version</th>
                    <th className="px-2 py-1">Change set</th>
                    <th className="px-2 py-1">When</th>
                    <th className="px-2 py-1">Active?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((h) => (
                    <tr key={`${h.object_pk}`} className="hover:bg-slate-50">
                      <td className="px-2 py-1 text-xs">
                        <LayerBadge layer={h.layer} />
                      </td>
                      <td className="px-2 py-1 font-mono text-xs text-slate-700">v{h.version}</td>
                      <td className="px-2 py-1">
                        <Link
                          href={{ pathname: `/changes/${encodeURIComponent(h.change_set_id)}` }}
                          className="font-mono text-xs text-brand-700 hover:underline"
                        >
                          {h.change_set_id.slice(0, 20)}…
                        </Link>
                      </td>
                      <td className="px-2 py-1 font-mono text-xs text-slate-500">
                        {new Date(h.created_at).toLocaleString(session.locale)}
                      </td>
                      <td className="px-2 py-1 text-xs">
                        {h.valid_until === null ? (
                          <span className="inline-flex rounded bg-green-100 px-1.5 py-0.5 text-green-800">
                            active
                          </span>
                        ) : (
                          <span className="text-slate-400">superseded</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function BodyWithProvenance({
  body,
  history,
}: {
  readonly body: Record<string, unknown>;
  readonly history: readonly MetaObjectRow[];
}): JSX.Element {
  // Approximate per-key provenance by asking: which layer's active
  // body for this key is the deepest match of the final value?
  // `history.filter(valid_until IS NULL)` gives one active row per
  // contributing layer. For each key in the resolved body, pick the
  // highest-layer row whose `body[key]` matches the resolved value.
  const activeRows = history.filter((h) => h.valid_until === null);
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className="px-2 py-1">Field</th>
          <th className="px-2 py-1">Value</th>
          <th className="px-2 py-1">Provenance</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {Object.entries(body).map(([k, v]) => {
          const source = attributionFor(k, v, activeRows);
          const overridden = isOverridden(k, v, activeRows);
          return (
            <tr key={k} className={overridden ? "bg-emerald-50" : ""}>
              <td className="w-40 px-2 py-1 font-mono text-xs text-slate-700">{k}</td>
              <td className="px-2 py-1 font-mono text-xs text-slate-800">
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all">
                  {formatValue(v)}
                </pre>
              </td>
              <td className="w-24 px-2 py-1 text-xs">
                <LayerBadge layer={source} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function attributionFor(key: string, value: unknown, activeRows: readonly MetaObjectRow[]): string {
  // Highest (most specific) layer whose body[key] matches wins.
  const layerOrder = ["L4", "L3", "L2", "L1", "L0"];
  for (const layer of layerOrder) {
    const row = activeRows.find((r) => r.layer === layer);
    if (row === undefined || row.body === null) continue;
    const rowValue = (row.body as Record<string, unknown>)[key];
    if (rowValue !== undefined && deepEqual(rowValue, value)) {
      return layer;
    }
  }
  return "?";
}

function isOverridden(key: string, value: unknown, activeRows: readonly MetaObjectRow[]): boolean {
  // Overridden = at least two active rows define the key but the
  // values differ (meaning a higher layer replaced a lower one).
  const values = activeRows
    .map((r) => (r.body as Record<string, unknown> | null)?.[key])
    .filter((v) => v !== undefined);
  if (values.length < 2) return false;
  return !values.every((v) => deepEqual(v, value));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

function LayerBadge({ layer }: { readonly layer: string }): JSX.Element {
  const palette: Record<string, string> = {
    L0: "bg-slate-100 text-slate-700",
    L1: "bg-amber-100 text-amber-800",
    L2: "bg-emerald-100 text-emerald-800",
    L3: "bg-indigo-100 text-indigo-700",
    L4: "bg-fuchsia-100 text-fuchsia-700",
    "?": "bg-slate-50 text-slate-400",
  };
  const cls = palette[layer] ?? "bg-slate-100 text-slate-700";
  return <span className={`inline-flex rounded px-1.5 py-0.5 font-mono ${cls}`}>{layer}</span>;
}
