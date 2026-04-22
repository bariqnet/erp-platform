// Localization primitives (RFC §2.2 · "Localization" object type, plus the
// `label: { en, ar }` shape used across every other object type).
//
// CLAUDE.md §2 pins Arabic as a primary language. RTL behavior is handled
// by the i18n runtime in @erp/i18n; this module only defines the data shapes.

import { z } from "zod";

import { ObjectIdSchema } from "./object-id.js";

// ── Locale ────────────────────────────────────────────────────────────────
// BCP-47 tag: "en", "ar", "ar-IQ", "fr-CA". Validated by a minimal regex so
// future locales (Kurdish "ku", Assyrian neo-Aramaic "aii") don't require
// a schema change.

const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2,3})?$/;

export const LocaleSchema = z.string().regex(LOCALE_PATTERN, {
  message: "locale must be BCP-47-like (e.g. 'en', 'ar', 'ar-IQ')",
});

export type Locale = z.infer<typeof LocaleSchema>;

// ── LocalizedString ───────────────────────────────────────────────────────
// The `label` field in every domain type: a map from locale to the
// translated display string. `en` is required (English is the fallback
// pillar per CLAUDE.md §2); other locales are optional.

export const LocalizedStringSchema = z
  .object({ en: z.string().min(1) })
  .catchall(z.string());

export type LocalizedString = z.infer<typeof LocalizedStringSchema>;

// ── Localization object type (RFC §2.2) ──────────────────────────────────
// Per-locale override for labels, formats, and UI text on a specific
// metadata target (e.g., override Customer's label for Arabic-speaking
// tenants).

export const LocalizationBodySchema = z
  .object({
    locale: LocaleSchema,
    target: ObjectIdSchema,
    overrides: z.record(z.string(), z.string()),
  })
  .strict();

export type LocalizationBody = z.infer<typeof LocalizationBodySchema>;
