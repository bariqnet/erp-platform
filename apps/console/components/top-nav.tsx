import Link from "next/link";

import { setLocaleAction, logoutAction } from "../app/actions";
import { t } from "../lib/i18n";

import type { Session } from "../lib/session";

/**
 * Top navigation bar. Server Component — reads the session passed
 * from the layout and renders an anchor to /entities/ent.customer
 * plus a logout button. The locale toggle is a form button that
 * calls the `setLocaleAction` Server Action, so there's no Client
 * Component state anywhere in the header.
 */
export function TopNav({ session }: { readonly session: Session | null }): JSX.Element {
  const locale = session?.locale ?? "en";
  const nextLocale = locale === "en" ? "ar" : "en";
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-semibold text-slate-900 hover:text-brand-600">
          {t(locale, "app_title")}
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {session !== null ? (
            <>
              <Link
                href={{ pathname: "/entities/ent.customer" }}
                className="text-slate-600 hover:text-brand-600"
              >
                {t(locale, "entities")}
              </Link>
              <Link
                href={{ pathname: "/metadata" }}
                className="text-slate-600 hover:text-brand-600"
              >
                {t(locale, "nav_metadata")}
              </Link>
              <Link href={{ pathname: "/changes" }} className="text-slate-600 hover:text-brand-600">
                {t(locale, "nav_changes")}
              </Link>
              <span className="hidden sm:inline text-slate-400">·</span>
              <span className="hidden sm:inline text-slate-500">
                {t(locale, "session_banner_as")}{" "}
                <span className="font-mono text-xs text-slate-700">{session.tenantId}</span>
              </span>
            </>
          ) : null}
          <form action={setLocaleAction.bind(null, nextLocale)}>
            <button
              type="submit"
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
            >
              {t(locale, "locale_toggle")}
            </button>
          </form>
          {session !== null ? (
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
              >
                {t(locale, "logout")}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </header>
  );
}
