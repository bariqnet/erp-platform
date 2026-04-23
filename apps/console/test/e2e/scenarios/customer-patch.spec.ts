// Scenario 1 — Customer PATCH round-trip.
//
// The core console happy-path: shared auth state is already in place
// (see `auth.setup.ts`), so we land on the Customer list, open the
// first row, change `loyalty_tier`, save, reload, confirm the new
// value survived the round-trip through PATCH → Postgres → GET.
//
// `loyalty_tier` is interesting because it's the L2 custom field
// added for t_demo_retail (RFC §2, seeded by `pnpm db:seed`). Patching
// it proves the metadata-driven form renders tenant-level fields and
// the Runtime API accepts them end-to-end — exactly the story Phase 1
// ships.

import { expect, test } from "@playwright/test";

test.describe("apps/console — customer PATCH round-trip", () => {
  test("change loyalty_tier and see it persist", async ({ page }) => {
    await page.goto("/entities/ent.customer");
    await expect(page.getByRole("heading", { name: /ent\.customer/ })).toBeVisible();

    // The seed populates 50 customers. The list renders newest-first
    // by `updated_at`; any row works for this scenario.
    const firstOpen = page.getByRole("link", { name: "Open" }).first();
    await expect(firstOpen).toBeVisible();
    await firstOpen.click();

    await page.waitForURL(/\/entities\/ent\.customer\/[0-9a-f-]+$/);

    // The form renders one input per field from the resolved metadata.
    // `loyalty_tier` is an enum select because the L2 layer declares it
    // as a string enum with declared values.
    const select = page.locator('select[name="loyalty_tier"]');
    await expect(select).toBeVisible();

    // Pick a tier different from whatever is currently selected so the
    // PATCH is non-empty. The seed enum values are `gold / silver /
    // bronze`; we rotate through them so repeated runs stay honest.
    const current = await select.inputValue();
    const options = ["gold", "silver", "bronze"].filter((v) => v !== current);
    const nextTier = options[0];
    expect(nextTier).toBeDefined();
    if (nextTier === undefined) return;

    await select.selectOption(nextTier);
    const saveBtn = page.getByRole("button", { name: /^Save$/ });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // The form action returns { saved: true } which the client form
    // renders as a "Saved." banner.
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });

    // Reload the page — the Server Component re-fetches the row and
    // resolved metadata. The select should now show the new tier.
    await page.reload();
    await expect(page.locator('select[name="loyalty_tier"]')).toHaveValue(nextTier);

    // Bonus sanity: the Raw JSON panel includes the new value too.
    const rawJsonDetails = page.locator("details", { hasText: "Raw JSON" });
    await rawJsonDetails.click();
    await expect(rawJsonDetails).toContainText(`"loyalty_tier": "${nextTier}"`);
  });
});
