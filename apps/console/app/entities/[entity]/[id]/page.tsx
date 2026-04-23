import Link from "next/link";
import { redirect } from "next/navigation";

import { ApiError, getEntityRow, getResolvedObject } from "../../../../lib/api";
import { t } from "../../../../lib/i18n";
import { readSession } from "../../../../lib/session";

import { EntityForm } from "./entity-form";

import type { EntityRow, ResolvedObjectResponse } from "../../../../lib/api";

interface PageProps {
  readonly params: { readonly entity: string; readonly id: string };
}

export default async function EntityDetailPage(props: PageProps): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");
  const locale = session.locale;
  const entityId = decodeURIComponent(props.params.entity);
  const rowId = props.params.id;

  // Fetch the row + resolved entity metadata in parallel. The metadata
  // drives the form shape (every field becomes a form input). The L2
  // overlay on t_demo_retail's Customer adds loyalty_tier to the
  // resolved body; the form picks it up automatically, with no code
  // change in the console.
  let row: EntityRow | null = null;
  let resolved: ResolvedObjectResponse | null = null;
  let loadError: string | null = null;
  try {
    [row, resolved] = await Promise.all([
      getEntityRow(session, entityId, rowId),
      getResolvedObject(session, entityId),
    ]);
  } catch (err) {
    loadError =
      err instanceof ApiError ? `${err.status} · ${err.detail ?? err.kind ?? ""}` : "load failed";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <Link
          href={{ pathname: `/entities/${encodeURIComponent(entityId)}` }}
          className="text-slate-500 hover:text-brand-600"
        >
          ← {t(locale, "detail_back")}
        </Link>
      </div>

      {loadError !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      ) : row !== null && resolved !== null ? (
        <div className="space-y-4">
          <div className="rounded-lg bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h1 className="font-mono text-sm text-slate-500">{row.row_id}</h1>
                <p className="mt-0.5 text-lg font-semibold text-slate-900">{entityId}</p>
              </div>
              <div className="text-xs font-mono text-slate-500">
                <div>created: {new Date(row.created_at).toLocaleString(locale)}</div>
                <div>updated: {new Date(row.updated_at).toLocaleString(locale)}</div>
              </div>
            </div>
            <EntityForm
              entityId={entityId}
              rowId={row.row_id}
              body={row.body}
              resolvedBody={resolved.body}
              locale={locale}
            />
          </div>
          <details className="rounded-lg bg-white p-6 shadow-sm">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              Raw JSON
            </summary>
            <pre className="mt-3 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(row, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}
