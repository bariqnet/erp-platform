"use client";

import { useFormState, useFormStatus } from "react-dom";

import { t, type Locale } from "../../lib/i18n";
import { loginAction, type LoginFormState } from "../actions";

const INITIAL_STATE: LoginFormState = { error: null };

/**
 * Client login form. Calls the `loginAction` Server Action, which
 * writes the dev-auth cookie and redirects. CLAUDE.md §2: "Client
 * Components at the interaction boundary" — the form itself is
 * client-side for the useFormState hook, but every other page renders
 * server-side.
 */
export function LoginForm(): JSX.Element {
  // The login page isn't yet locale-aware (we don't have a session
  // cookie to read from). Default to English on the login screen —
  // the locale toggle in the TopNav still flips it after sign-in.
  const locale: Locale = "en";
  const [state, formAction] = useFormState(loginAction, INITIAL_STATE);
  return (
    <form action={formAction} className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">{t(locale, "login_title")}</h1>

      <div>
        <label htmlFor="tenant_id" className="block text-sm font-medium text-slate-700">
          {t(locale, "login_tenant")}
        </label>
        <input
          id="tenant_id"
          name="tenant_id"
          type="text"
          required
          defaultValue="t_demo_retail"
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </div>

      <div>
        <label htmlFor="user_id" className="block text-sm font-medium text-slate-700">
          {t(locale, "login_user")}
        </label>
        <input
          id="user_id"
          name="user_id"
          type="text"
          required
          defaultValue="u_demo"
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </div>

      <div>
        <label htmlFor="roles" className="block text-sm font-medium text-slate-700">
          {t(locale, "login_roles")}
        </label>
        <input
          id="roles"
          name="roles"
          type="text"
          defaultValue="prm.admin"
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">{t(locale, "login_roles_hint")}</p>
      </div>

      <input type="hidden" name="locale" value="en" />

      {state.error !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <Submit locale={locale} />
    </form>
  );
}

function Submit({ locale }: { readonly locale: Locale }): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
    >
      {pending ? `${t(locale, "login_submit")}…` : t(locale, "login_submit")}
    </button>
  );
}
