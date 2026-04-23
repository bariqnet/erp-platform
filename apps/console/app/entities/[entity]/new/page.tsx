import Link from "next/link";
import { redirect } from "next/navigation";

import { ApiError, getResolvedObject } from "../../../../lib/api";
import { t } from "../../../../lib/i18n";
import { readSession } from "../../../../lib/session";

import { CreateEntityForm } from "./create-entity-form";

import type { ResolvedObjectResponse } from "../../../../lib/api";

interface PageProps {
  readonly params: { readonly entity: string };
}

export default async function NewEntityRowPage(props: PageProps): Promise<JSX.Element> {
  const session = readSession();
  if (session === null) redirect("/login");
  const locale = session.locale;
  const entityId = decodeURIComponent(props.params.entity);

  // Resolve entity metadata server-side. The fields + required flags
  // drive which inputs the CreateEntityForm renders — same shape as
  // the detail page, but bound to an empty body.
  let resolved: ResolvedObjectResponse | null = null;
  let loadError: string | null = null;
  try {
    resolved = await getResolvedObject(session, entityId);
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
      ) : resolved !== null ? (
        <div className="rounded-lg bg-white p-6 shadow-sm">
          <div className="mb-4">
            <h1 className="text-lg font-semibold text-slate-900">
              {t(locale, "new_title")} ·{" "}
              <span className="font-mono text-sm text-slate-500">{entityId}</span>
            </h1>
            <p className="mt-1 text-sm text-slate-500">{t(locale, "new_hint")}</p>
          </div>
          <CreateEntityForm entityId={entityId} resolvedBody={resolved.body} locale={locale} />
        </div>
      ) : null}
    </div>
  );
}
