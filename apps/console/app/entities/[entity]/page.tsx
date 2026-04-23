import Link from "next/link";
import { redirect } from "next/navigation";

import { ApiError, listEntityObjects, listEntityRows } from "../../../lib/api";
import { t, type Locale } from "../../../lib/i18n";
import { readSession } from "../../../lib/session";

import type { EntityRow, MetaObjectRow } from "../../../lib/api";

interface PageProps {
  readonly params: { readonly entity: string };
  readonly searchParams: { readonly page?: string };
}

const PAGE_SIZE = 25;

export default async function EntitiesListPage(props: PageProps): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");
  const locale = session.locale;
  const entityId = decodeURIComponent(props.params.entity);
  const page = Math.max(1, Number.parseInt(props.searchParams.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let rows: readonly EntityRow[] = [];
  let loadError: string | null = null;
  try {
    const res = await listEntityRows(session, entityId, { limit: PAGE_SIZE, offset });
    rows = res.items;
  } catch (err) {
    loadError =
      err instanceof ApiError ? `${err.status} · ${err.detail ?? err.kind ?? ""}` : "load failed";
  }

  let entityObjects: readonly MetaObjectRow[] = [];
  try {
    entityObjects = await listEntityObjects(session);
  } catch {
    /* non-fatal — fall through to empty sidebar */
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
      <aside className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          {t(locale, "entities")}
        </h2>
        <ul className="space-y-1 text-sm">
          {entityObjects.length === 0 ? (
            <li className="text-slate-400">—</li>
          ) : (
            entityObjects.map((e) => (
              <li key={e.object_id}>
                <Link
                  href={{ pathname: `/entities/${encodeURIComponent(e.object_id)}` }}
                  className={
                    e.object_id === entityId
                      ? "block rounded bg-brand-50 px-2 py-1 font-medium text-brand-700"
                      : "block rounded px-2 py-1 text-slate-700 hover:bg-slate-100"
                  }
                >
                  <span className="font-mono text-xs">{e.object_id}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      </aside>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">
            {entityId}{" "}
            <span className="text-sm font-normal text-slate-500">· {t(locale, "list_title")}</span>
          </h1>
          <Link
            href={{ pathname: `/entities/${encodeURIComponent(entityId)}/new` }}
            className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t(locale, "list_new")}
          </Link>
        </div>

        {loadError !== null ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {loadError}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg bg-white p-6 text-center shadow-sm">
            <p className="text-sm text-slate-500">{t(locale, "list_none")}</p>
            <Link
              href={{ pathname: `/entities/${encodeURIComponent(entityId)}/new` }}
              className="mt-3 inline-block rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              {t(locale, "list_new")}
            </Link>
          </div>
        ) : (
          <RowTable rows={rows} entityId={entityId} locale={locale} />
        )}

        <Pagination
          entityId={entityId}
          page={page}
          hasMore={rows.length === PAGE_SIZE}
          locale={locale}
        />
      </section>
    </div>
  );
}

function RowTable({
  rows,
  entityId,
  locale,
}: {
  readonly rows: readonly EntityRow[];
  readonly entityId: string;
  readonly locale: Locale;
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">{t(locale, "list_row_id")}</th>
            <th className="px-4 py-3">Summary</th>
            <th className="px-4 py-3">{t(locale, "list_status")}</th>
            <th className="px-4 py-3">{t(locale, "list_updated")}</th>
            <th className="px-4 py-3 ltr:text-right rtl:text-left" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.row_id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-mono text-xs text-slate-600">
                {row.row_id.slice(0, 8)}…
              </td>
              <td className="px-4 py-3">{summaryOf(row)}</td>
              <td className="px-4 py-3">
                <StatusPill status={row.status} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-slate-500">
                {new Date(row.updated_at).toLocaleString(locale)}
              </td>
              <td className="px-4 py-3 ltr:text-right rtl:text-left">
                <Link
                  href={{
                    pathname: `/entities/${encodeURIComponent(entityId)}/${row.row_id}`,
                  }}
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                >
                  {t(locale, "list_open")}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summaryOf(row: EntityRow): string {
  const body = row.body;
  // Prefer name → sku → number → first string field → row_id suffix.
  for (const key of ["name", "sku", "number"]) {
    const v = body[key];
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
      // localized_string
      const en = (v as Record<string, unknown>)["en"];
      if (typeof en === "string") return en;
      const first = Object.values(v)[0];
      if (typeof first === "string") return first;
    }
  }
  for (const v of Object.values(body)) {
    if (typeof v === "string") return v;
  }
  return row.row_id.slice(0, 12);
}

function StatusPill({ status }: { readonly status: string | null }): JSX.Element {
  if (status === null) return <span className="text-slate-400">—</span>;
  const color =
    status === "active" || status === "posted" || status === "paid"
      ? "bg-green-100 text-green-800"
      : status === "inactive" || status === "void"
        ? "bg-slate-200 text-slate-700"
        : "bg-amber-100 text-amber-800";
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>
  );
}

function Pagination({
  entityId,
  page,
  hasMore,
  locale,
}: {
  readonly entityId: string;
  readonly page: number;
  readonly hasMore: boolean;
  readonly locale: Locale;
}): JSX.Element {
  void locale;
  return (
    <div className="mt-4 flex items-center gap-2 text-xs">
      {page > 1 ? (
        <Link
          href={{
            pathname: `/entities/${encodeURIComponent(entityId)}`,
            query: page === 2 ? {} : { page: page - 1 },
          }}
          className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          ← Prev
        </Link>
      ) : null}
      <span className="text-slate-500">Page {page}</span>
      {hasMore ? (
        <Link
          href={{
            pathname: `/entities/${encodeURIComponent(entityId)}`,
            query: { page: page + 1 },
          }}
          className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-100"
        >
          Next →
        </Link>
      ) : null}
    </div>
  );
}
