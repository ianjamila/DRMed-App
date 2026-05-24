/**
 * Playwright UI smoke: Chemistry consolidated result patient portal card.
 *
 * SKIPPED: Playwright is not yet installed in this project (@playwright/test
 * is absent from package.json). To enable:
 *
 *   1. Install Playwright:
 *        npm install -D @playwright/test
 *        npx playwright install chromium
 *
 *   2. Add a "test:e2e" script to package.json:
 *        "test:e2e": "playwright test"
 *
 *   3. Create playwright.config.ts pointing at the dev server
 *      (baseURL: "http://localhost:3000").
 *
 *   4. The fixture requires a patient session. The patient auth uses DRM-ID
 *      + PIN (not Supabase Auth), so the test needs:
 *        - A seeded fixture patient with a known DRM-ID + PIN.
 *        - A visit with FBS_RBS, LIPID_PROFILE, HBA1C all released.
 *        - A corresponding results row with report_group_id pointing to
 *          the CHEMISTRY group.
 *      These must be created/torn-down around the test run. The simplest
 *      approach is a globalSetup script that calls the seed scripts and
 *      a globalTeardown that cleans up.
 *
 * Once the above is in place, remove the `.skip` from the test block.
 */

import { test, expect } from "@playwright/test";

// -------------------------------------------------------------------------
// Scenario: Chemistry consolidated result shows as a single "Chemistry"
// card in the patient portal, not as three separate FBS/LIPID/HBA1C rows.
// -------------------------------------------------------------------------
test.describe("Chemistry consolidated result — patient portal", () => {
  test.skip(
    true,
    "Playwright not installed. See comment block at top of this file for setup instructions.",
  );

  test("shows one Chemistry card with sub-line listing ordered tests", async ({
    page,
  }) => {
    // Sign in with the fixture patient.
    await page.goto("/portal/sign-in");
    await page.getByLabel("DRM-ID").fill("SMK-25-UI");
    await page.getByLabel("PIN").fill("TESTPIN1");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("/portal");

    // The results table should show exactly ONE row for Chemistry
    // (not three separate rows for FBS_RBS, LIPID_PROFILE, HBA1C).
    const rows = page.getByRole("row", { name: /Chemistry/i });
    await expect(rows).toHaveCount(1);

    // The sub-label should list the constituent tests.
    const subLabel = page.getByText(/FBS.*Lipid|Lipid.*FBS/i).first();
    await expect(subLabel).toBeVisible();

    // The Download button should be present and enabled.
    const dlBtn = rows.getByRole("button", { name: /download/i });
    await expect(dlBtn).toBeEnabled();
  });

  test("mobile 390×844: Chemistry card is visible and tap target is adequate", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portal/sign-in");
    await page.getByLabel("DRM-ID").fill("SMK-25-UI");
    await page.getByLabel("PIN").fill("TESTPIN1");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("/portal");

    const dlBtn = page.getByRole("button", { name: /download/i }).first();
    await expect(dlBtn).toBeVisible();

    // Verify tap target >= 44px.
    const box = await dlBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
