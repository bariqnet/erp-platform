// Seed fixtures — EntityBodies, PermissionBodies, and demo-row
// generators for the `t_demo_retail` reference tenant (TASK-13).
//
// Kept in one module so the seed script is a short orchestrator. The
// shapes here validate against the Zod schemas in @erp/core — when a
// future change to Field or EntityBody tightens validation, the seed
// fails loudly at run time and we update the fixtures.

import { createHash } from "node:crypto";

import { type EntityBody, type PermissionBody } from "@erp/core";

// ── Stable identifiers ─────────────────────────────────────────────

export const TENANT_ID = "t_demo_retail";

/**
 * Deterministic change-set ids for idempotency checks. A present row
 * with one of these ids is the signal that its seed phase is done;
 * re-running the script with the same row already in place is a
 * no-op.
 */
export const VENDOR_CHANGE_SET_ID = "cs_seed_platform_v1";
export const TENANT_CHANGE_SET_ID = "cs_seed_demo_retail_v1";

export const OBJECT_IDS = {
  customer: "ent.customer",
  product: "ent.product",
  invoice: "ent.invoice",
  admin: "prm.admin",
  viewer: "prm.viewer",
} as const;

// ── Vendor-level Entity bodies (L0) ────────────────────────────────

export const CUSTOMER_ENTITY_L0: EntityBody = {
  name: "Customer",
  plural: "Customers",
  label: { en: "Customer", ar: "عميل" },
  storage: { strategy: "jsonb" },
  lifecycle: { states: ["active", "inactive"], initial: "active" },
  audit: true,
  fields: [
    { name: "name", type: "string", required: true, max_length: 120 },
    { name: "phone", type: "phone" },
    {
      name: "email",
      type: "string",
      max_length: 254,
      // Minimal RFC-5321-ish shape. Real MX/SMTP checks live at the
      // edge adapter when email is first wired up.
      regex: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    },
    { name: "currency", type: "string", required: true, max_length: 3 },
    { name: "credit_limit_fils", type: "money", currency_field: "currency" },
    { name: "national_id", type: "national_id", country: "IQ" },
  ],
};

export const PRODUCT_ENTITY_L0: EntityBody = {
  name: "Product",
  plural: "Products",
  label: { en: "Product", ar: "منتج" },
  storage: { strategy: "jsonb" },
  lifecycle: { states: ["active", "inactive"], initial: "active" },
  audit: true,
  fields: [
    { name: "sku", type: "string", required: true, max_length: 64, regex: "^[A-Z0-9-]+$" },
    { name: "name", type: "localized_string", required: true, max_length: 200 },
    { name: "currency", type: "string", required: true, max_length: 3 },
    { name: "price_fils", type: "money", required: true, currency_field: "currency" },
    {
      name: "category",
      type: "enum",
      values: ["grocery", "electronics", "apparel", "household", "other"],
    },
  ],
};

export const INVOICE_ENTITY_L0: EntityBody = {
  name: "Invoice",
  plural: "Invoices",
  label: { en: "Invoice", ar: "فاتورة" },
  storage: { strategy: "jsonb" },
  lifecycle: { states: ["draft", "posted", "paid", "void"], initial: "draft" },
  audit: true,
  fields: [
    { name: "number", type: "string", required: true, max_length: 32, regex: "^INV-[0-9]+$" },
    {
      name: "customer_id",
      type: "reference",
      required: true,
      target: "ent.customer",
      on_delete: "restrict",
    },
    { name: "currency", type: "string", required: true, max_length: 3 },
    { name: "total_fils", type: "money", required: true, currency_field: "currency" },
    { name: "issued_at", type: "datetime", required: true },
    { name: "due_at", type: "datetime" },
  ],
};

// ── Permissions (L0) ───────────────────────────────────────────────

export const ADMIN_PERMISSION_L0: PermissionBody = {
  role_id: "prm.admin",
  label: { en: "Administrator", ar: "مسؤول" },
  description: "Full CRUD across every demo entity.",
  entity_grants: {
    "ent.customer": ["read", "create", "update", "delete"],
    "ent.product": ["read", "create", "update", "delete"],
    "ent.invoice": ["read", "create", "update", "delete"],
  },
};

export const VIEWER_PERMISSION_L0: PermissionBody = {
  role_id: "prm.viewer",
  label: { en: "Viewer", ar: "مراقب" },
  description: "Read-only across every demo entity.",
  entity_grants: {
    "ent.customer": ["read"],
    "ent.product": ["read"],
    "ent.invoice": ["read"],
  },
};

// ── Tenant-level overlay (L2 for t_demo_retail) ────────────────────

/**
 * L2 override for ent.customer: adds a `loyalty_tier` enum field on
 * top of the vendor body. Demonstrates the five-layer customization
 * model: a tenant adds a column without forking code (CLAUDE.md §1,
 * RFC §2).
 *
 * Default merge strategy is `replace`, so the L2 body must carry
 * every field the L0 body declared plus the new one.
 */
export const CUSTOMER_ENTITY_L2_WITH_LOYALTY: EntityBody = {
  ...CUSTOMER_ENTITY_L0,
  fields: [
    ...CUSTOMER_ENTITY_L0.fields,
    {
      name: "loyalty_tier",
      type: "enum",
      values: ["bronze", "silver", "gold", "platinum"],
      label: { en: "Loyalty Tier", ar: "مستوى الولاء" },
      indexed: true,
    },
  ],
};

// ── Row generators ─────────────────────────────────────────────────

export interface DemoRow<TBody = Record<string, unknown>> {
  readonly row_id: string;
  readonly body: TBody;
  readonly status: string;
}

const CITY_EN = [
  "Baghdad",
  "Basra",
  "Erbil",
  "Mosul",
  "Najaf",
  "Sulaimaniyah",
  "Kirkuk",
  "Karbala",
];
const CITY_AR = ["بغداد", "البصرة", "أربيل", "الموصل", "النجف", "السليمانية", "كركوك", "كربلاء"];
const TIERS = ["bronze", "silver", "gold", "platinum"] as const;
const CATEGORIES = ["grocery", "electronics", "apparel", "household", "other"] as const;

/**
 * uuid-v5-ish: deterministic UUID derived from a seed + index. Uses
 * sha1 (uuidv5's algorithm) over a stable namespace so reruns produce
 * the same row_id and ON CONFLICT DO NOTHING collapses duplicates at
 * the database layer.
 */
export function deterministicUuid(namespace: string, name: string): string {
  const digest = createHash("sha1").update(`${namespace}:${name}`).digest();
  // Stamp version (5) and variant bits, then format as a UUID string.
  const bytes = Buffer.from(digest.slice(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // v5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

function pad(n: number, width = 4): string {
  return n.toString().padStart(width, "0");
}

export function generateCustomers(count: number): DemoRow[] {
  const out: DemoRow[] = [];
  for (let i = 1; i <= count; i += 1) {
    const cityIdx = i % CITY_EN.length;
    const tierIdx = i % TIERS.length;
    const hasEmail = i % 3 !== 0;
    out.push({
      row_id: deterministicUuid("seed.customer", String(i)),
      status: i % 10 === 0 ? "inactive" : "active",
      body: {
        name: `Customer ${pad(i)} · ${CITY_EN[cityIdx]} — عميل ${pad(i)} · ${CITY_AR[cityIdx]}`,
        phone: `+9647${pad(700_000_000 + i, 9)}`,
        currency: "IQD",
        credit_limit_fils: (i % 10) * 1_000_000,
        loyalty_tier: TIERS[tierIdx],
        // Only populate optional email on ~2/3 of rows so the seed
        // exercises "missing optional field" behavior too.
        ...(hasEmail ? { email: `customer.${pad(i)}@demo-retail.iq` } : {}),
      },
    });
  }
  return out;
}

export function generateProducts(count: number): DemoRow[] {
  const out: DemoRow[] = [];
  const NAMES = [
    { en: "Rice 5kg", ar: "رز ٥ كيلو" },
    { en: "Tea 250g", ar: "شاي ٢٥٠ غرام" },
    { en: "Cooking Oil 1L", ar: "زيت طبخ ١ لتر" },
    { en: "Sugar 1kg", ar: "سكر ١ كيلو" },
    { en: "Flour 10kg", ar: "طحين ١٠ كيلو" },
    { en: "LED Bulb 9W", ar: "لمبة ليد ٩ واط" },
    { en: "Kitchen Towel", ar: "منشفة مطبخ" },
    { en: "Detergent 2L", ar: "منظف ٢ لتر" },
    { en: "Yogurt 500g", ar: "لبن ٥٠٠ غرام" },
    { en: "Bread Bag", ar: "كيس خبز" },
  ];
  for (let i = 1; i <= count; i += 1) {
    const sample = NAMES[i % NAMES.length];
    if (sample === undefined) continue; // unreachable — NAMES.length > 0
    out.push({
      row_id: deterministicUuid("seed.product", String(i)),
      status: i % 20 === 0 ? "inactive" : "active",
      body: {
        sku: `SKU-${pad(i, 5)}`,
        name: { en: `${sample.en} #${i}`, ar: `${sample.ar} رقم ${i}` },
        currency: "IQD",
        price_fils: 500 * i, // 500 fils per unit of i — keeps the math readable
        category: CATEGORIES[i % CATEGORIES.length] ?? "other",
      },
    });
  }
  return out;
}

export function generateInvoices(count: number, customerIds: readonly string[]): DemoRow[] {
  if (customerIds.length === 0) {
    throw new Error("generateInvoices: need at least one customer_id to link against");
  }
  const out: DemoRow[] = [];
  const STATES = ["draft", "posted", "paid", "void"] as const;
  const baseDate = new Date("2026-01-01T00:00:00Z").getTime();
  const DAY = 86_400_000;
  for (let i = 1; i <= count; i += 1) {
    const issuedAt = new Date(baseDate + i * DAY).toISOString();
    const dueAt = new Date(baseDate + i * DAY + 30 * DAY).toISOString();
    const customerId = customerIds[i % customerIds.length];
    if (customerId === undefined) continue; // unreachable
    out.push({
      row_id: deterministicUuid("seed.invoice", String(i)),
      status: STATES[i % STATES.length] ?? "draft",
      body: {
        number: `INV-${pad(i, 6)}`,
        customer_id: customerId,
        currency: "IQD",
        total_fils: 1_000 * i * 25,
        issued_at: issuedAt,
        due_at: dueAt,
      },
    });
  }
  return out;
}
