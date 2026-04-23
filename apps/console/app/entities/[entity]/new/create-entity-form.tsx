"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";

import { t, type Locale } from "../../../../lib/i18n";
import { createRowAction, type CreateRowState } from "../../../actions";

// Narrow Field shape mirrored from @erp/core. Same copy the
// detail-page EntityForm uses — kept local so the client bundle
// doesn't pull in all of @erp/core + Zod.
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
  readonly lifecycle?: { readonly initial?: string };
}

const INITIAL: CreateRowState = { error: null, fieldErrors: {} };

/**
 * Create-row form rendered from the entity's resolved metadata.
 *
 * Shares the same per-field input logic as the detail page's
 * EntityForm but drops the diff-against-server and delete paths. On
 * submit, the Server Action POSTs the body to `/v1/:entity`; on
 * success the action redirects to the detail page for the new row;
 * on 400 validation failure the form surfaces field-level errors
 * from the problem+json `errors[]` array.
 */
export function CreateEntityForm({
  entityId,
  resolvedBody,
  locale,
}: {
  readonly entityId: string;
  readonly resolvedBody: Record<string, unknown>;
  readonly locale: Locale;
}): JSX.Element {
  const fields = useMemo<readonly FieldDef[]>(() => {
    const maybe = (resolvedBody as ResolvedEntityBody).fields;
    return Array.isArray(maybe) ? maybe : [];
  }, [resolvedBody]);

  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const action = createRowAction.bind(null, entityId);
  const [state, formAction] = useFormState(action, INITIAL);

  function setField(name: string, value: unknown): void {
    setDraft((prev) => {
      if (value === undefined || value === "") {
        const next = { ...prev };
        delete next[name];
        return next;
      }
      return { ...prev, [name]: value };
    });
  }

  // Serialize only fields the user touched. Optional fields with no
  // value are omitted so the server-side Zod validator sees them as
  // absent (not null).
  const body = useMemo<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = draft[f.name];
      if (v !== undefined && v !== "") out[f.name] = v;
    }
    return out;
  }, [draft, fields]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="__body__" value={JSON.stringify(body)} />

      {fields.length === 0 ? (
        <p className="text-sm text-slate-500">No field metadata on this entity.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {fields.map((f) => (
            <FieldInput
              key={f.name}
              field={f}
              value={draft[f.name]}
              fieldError={state.fieldErrors[f.name]}
              onChange={setField}
            />
          ))}
        </div>
      )}

      {state.error !== null ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {t(locale, "new_error")} <span className="font-mono text-xs">{state.error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <CreateButton locale={locale} />
        <a
          href={`/entities/${encodeURIComponent(entityId)}`}
          className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
        >
          {t(locale, "new_cancel")}
        </a>
      </div>
    </form>
  );
}

function FieldInput({
  field,
  value,
  fieldError,
  onChange,
}: {
  readonly field: FieldDef;
  readonly value: unknown;
  readonly fieldError: string | undefined;
  readonly onChange: (name: string, v: unknown) => void;
}): JSX.Element {
  const common =
    "mt-1 w-full rounded border px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-500";
  const borderCls = fieldError !== undefined ? "border-red-400 bg-red-50" : "border-slate-300";
  const inputCls = `${common} ${borderCls}`;

  const label = (
    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
      {field.name}
      {field.required === true ? <span className="text-red-500"> *</span> : null}
      <span className="ml-1 font-normal text-slate-400">{field.type}</span>
    </label>
  );

  let control: JSX.Element;

  if (field.type === "enum") {
    const values = field.values ?? [];
    control = (
      <select
        className={inputCls}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(field.name, e.target.value)}
      >
        <option value="">—</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "integer" || field.type === "decimal" || field.type === "money") {
    control = (
      <input
        type="number"
        step={field.type === "integer" || field.type === "money" ? 1 : "any"}
        className={inputCls}
        value={typeof value === "number" ? value : ""}
        onChange={(e) =>
          onChange(field.name, e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  } else if (field.type === "boolean") {
    control = (
      <select
        className={inputCls}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) =>
          onChange(field.name, e.target.value === "" ? undefined : e.target.value === "true")
        }
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else if (field.type === "localized_string") {
    const obj = (typeof value === "object" && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    control = (
      <div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2">
        {(["en", "ar"] as const).map((loc) => (
          <div key={loc}>
            <span className="block text-[10px] font-semibold uppercase text-slate-400">{loc}</span>
            <input
              type="text"
              className={inputCls}
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
    );
  } else {
    const inputType =
      field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : "text";
    control = (
      <input
        type={inputType}
        className={inputCls}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(field.name, e.target.value === "" ? undefined : e.target.value)}
        placeholder={placeholderFor(field)}
      />
    );
  }

  const wide = field.type === "localized_string";
  return (
    <div className={wide ? "md:col-span-2" : undefined}>
      {label}
      {control}
      {fieldError !== undefined ? <p className="mt-1 text-xs text-red-600">{fieldError}</p> : null}
    </div>
  );
}

function placeholderFor(field: FieldDef): string {
  switch (field.type) {
    case "phone":
      return "+9647700000000";
    case "reference":
      return field.target ?? "uuid";
    default:
      return "";
  }
}

function CreateButton({ locale }: { readonly locale: Locale }): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
    >
      {pending ? t(locale, "new_saving") : t(locale, "new_submit")}
    </button>
  );
}
