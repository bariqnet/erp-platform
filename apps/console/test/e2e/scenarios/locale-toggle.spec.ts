// Scenario 2 — Locale toggle + RTL.
//
// CLAUDE.md §2: Arabic is a primary language, RTL-first. The console
// layout reads the session's locale every render and sets
// `<html dir>` accordingly. Toggling is a Server Action (setLocaleAction
// in apps/console/app/actions.ts); flipping it must:
//
//   1. Change `<html dir>` from "ltr" to "rtl".
//   2. Render the Arabic translation for "Entities" in the top nav.
//
// Both assertions run against the real rendered HTML so a regression
// in the i18n path (missing string, wrong dir attribute, stale cookie)
// fails loudly.

import { expect, test } from "@playwright/test";

test.describe("apps/console — locale toggle + RTL", () => {
  test("toggling to Arabic flips dir=rtl and renders Arabic strings", async ({ page }) => {
    await page.goto("/entities/ent.customer");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    // English label for "Entities" in the top nav.
    await expect(page.getByRole("link", { name: "Entities" })).toBeVisible();

    // The locale toggle in the top nav shows the *opposite* locale
    // name — "عربي" when we're on English, "English" when we're on
    // Arabic. Click it.
    const toggle = page.getByRole("button", { name: "عربي" });
    await expect(toggle).toBeVisible();
    await toggle.click();

    // setLocaleAction writes the cookie and redirects to "/". Land,
    // then navigate back to the entities page under the new locale.
    await page.waitForURL("**/", { timeout: 10_000 });
    await page.goto("/entities/ent.customer");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    // Arabic label for "Entities" from lib/i18n.ts STRINGS.ar.
    await expect(page.getByRole("link", { name: "الكيانات" })).toBeVisible();

    // The toggle itself now reads "English" (flipping back would
    // restore LTR — we leave it flipped so the storage state stays
    // RTL for any follow-up assertions in the same worker run; the
    // customer-patch spec runs in its own browser context via the
    // shared storageState, so it is unaffected).
    await expect(page.getByRole("button", { name: "English" })).toBeVisible();

    // Flip back so subsequent runs (or a future third scenario) start
    // from the canonical LTR baseline.
    await page.getByRole("button", { name: "English" }).click();
    await page.waitForURL("**/", { timeout: 10_000 });
    await page.goto("/entities/ent.customer");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});
