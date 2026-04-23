"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";

import { t, type Locale } from "../../../../lib/i18n";
import { deleteRowAction, patchRowAction, type PatchRowState } from "../../../actions";

// The resolved EntityBody shape (from @erp/core). Duplicated here in
// narrow form to avoid dragging Zod into the client bundle — the
// Admin API already validated the shape before it got here.
interface FieldDef {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
  readonly max_length?: number;
  readonly values?: readonly string[];
  readonly currency_field?: string;
  readonly target?: string;
}

interface ResolvedEntityBody {
  readonly name?: string;
  readonly fields?: readonly FieldDef[];
}

const INITIAL: PatchRowState = { error: null, saved: false };

/**
 * Metadata-driven form. Renders one input per field from the resolved
 * entity metadata, pre-populated with the current row. The TYPE of
 * each input comes from the Field metadata — so when a tenant adds a
 * custom `loyalty_tier` enum field at L2, this form renders a
 * `<select>` with the declared values automatically, no change here.
 *
 * On submit, builds a PATCH body with only the *changed* keys and
 * sends it through the `patchRowAction` Server Action.
 */
export function EntityForm({
  entityId,
  rowId,
  body,
  resolvedBody,
  locale,
}: {
  readonly entityId: string;
  readonly rowId: string;
  readonly body: Record<string, unknown>;
  readonly resolvedBody: Record<string, unknown>;
  readonly locale: Locale;
}): JSX.Element {
  const fields = useMemo<readonly FieldDef[]>(() => {
    const maybe = (resolvedBody as ResolvedEntityBody).fields;
    return Array.isArray(maybe) ? maybe : [];
  }, [resolvedBody]);

  const [draft, setDraft] = useState<Record<string, unknown>>(body);

  const action = patchRowAction.bind(null, entityId, rowId);
  const [state, formAction] = useFormState(action, INITIAL);

  function setField(name: string, value: unknown): void {
    setDraft((prev) => ({ ...prev, [name]: value }));
  }

  // PATCH body = only keys that differ from the server's body.
  const patch = useMemo<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (!equalLoose(draft[f.name], body[f.name])) {
        if (draft[f.name] !== undefined && draft[f.name] !== "") {
          out[f.name] = draft[f.name];
        }
      }
    }
    return out;
  }, [draft, body, fields]);

  const hasChanges = Object.keys(patch).length > 0;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="__body__" value={JSON.stringify(patch)} />

      {fields.length === 0 ? (
        <p className="text-sm text-slate-500">No field metadata — render raw JSON instead.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {fields.map((f) => (
            <FieldInput key={f.name} field={f} value={draft[f.name]} onChange={setField} />
          ))}
        </div>
      )}

      {state.saved ? (
        <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {t(locale, "detail_saved")}
        </div>
      ) : null}
      {state.error !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {t(locale, "detail_error")} <span className="font-mono text-xs">{state.error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <SaveButton locale={locale} disabled={!hasChanges} />
        <DeleteButton entityId={entityId} rowId={rowId} locale={locale} />
        <span className="text-xs text-slate-500">
          {hasChanges ? `${Object.keys(patch).length} field(s) pending` : "no changes"}
        </span>
      </div>
    </form>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  readonly field: FieldDef;
  readonly value: unknown;
  readonly onChange: (name: string, v: unknown) => void;
}): JSX.Element {
  const common =
    "mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm font-mono focus:border-brand-500 focus:outline-none";
  const label = (
    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
      {field.name}
      {field.required ? <span className="text-red-500"> *</span> : null}
      <span className="ml-1 font-normal text-slate-400">{field.type}</span>
    </label>
  );

  if (field.type === "enum") {
    const values = field.values ?? [];
    return (
      <div>
        {label}
        <select
          name={field.name}
          className={common}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(field.name, e.target.value || undefined)}
        >
          <option value="">—</option>
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "integer" || field.type === "decimal" || field.type === "money") {
    return (
      <div>
        {label}
        <input
          type="number"
          name={field.name}
          step={field.type === "integer" || field.type === "money" ? 1 : "any"}
          className={common}
          value={typeof value === "number" ? value : ""}
          onChange={(e) =>
            onChange(field.name, e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <div>
        {label}
        <select
          name={field.name}
          className={common}
          value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(e) =>
            onChange(field.name, e.target.value === "" ? undefined : e.target.value === "true")
          }
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </div>
    );
  }

  if (field.type === "localized_string") {
    const obj = (typeof value === "object" && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    return (
      <div className="md:col-span-2">
        {label}
        <div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2">
          {(["en", "ar"] as const).map((loc) => (
            <div key={loc}>
              <span className="block text-[10px] font-semibold uppercase text-slate-400">
                {loc}
              </span>
              <input
                type="text"
                name={`${field.name}.${loc}`}
                className={common}
                value={typeof obj[loc] === "string" ? String(obj[loc]) : ""}
                onChange={(e) => {
                  const next: Record<string, string> = {};
                  for (const [k, v] of Object.entries(obj)) {
                    if (typeof v === "string") next[k] = v;
                  }
                  if (e.target.value === "") {
                    delete next[loc];
                  } else {
                    next[loc] = e.target.value;
                  }
                  onChange(field.name, Object.keys(next).length > 0 ? next : undefined);
                }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // string, phone, email-like, date, datetime, reference, etc.
  return (
    <div>
      {label}
      <input
        type={
          field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : "text"
        }
        name={field.name}
        className={common}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(field.name, e.target.value === "" ? undefined : e.target.value)}
        placeholder={placeholderFor(field)}
      />
    </div>
  );
}

function placeholderFor(field: FieldDef): string {
  switch (field.type) {
    case "phone":
      return "+9647700000000";
    case "reference":
      return field.target ?? "ent.target row_id (uuid)";
    default:
      return "";
  }
}

function equalLoose(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function SaveButton({
  locale,
  disabled,
}: {
  readonly locale: Locale;
  readonly disabled: boolean;
}): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
    >
      {pending ? t(locale, "detail_saving") : t(locale, "detail_save")}
    </button>
  );
}

function DeleteButton({
  entityId,
  rowId,
  locale,
}: {
  readonly entityId: string;
  readonly rowId: string;
  readonly locale: Locale;
}): JSX.Element {
  const action = deleteRowAction.bind(null, entityId, rowId);
  return (
    <form action={action}>
      <button
        type="submit"
        className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
        onClick={(e) => {
          if (!window.confirm(`Delete ${rowId}?`)) {
            e.preventDefault();
          }
        }}
      >
        {t(locale, "detail_delete")}
      </button>
    </form>
  );
}
