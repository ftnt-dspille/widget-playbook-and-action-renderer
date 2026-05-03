"use strict";
// One-shot probe: open widget-action-renderer in the harness with view-panel
// context + a real alert UUID, open the edit modal through the wizard's first
// step, settle, dump every captured error to test-results/probe-report.json.
// Goal is to baseline what's noisy before any feature work.

const { test, expect } = require("@playwright/test");
const path = require("path");
const { probeWidget, meaningfulErrors } = require("../../../../fortisoar-widget-harness/tests/e2e/_probe");

const ALERT_UUID = process.env.AR_ALERT_UUID || "db7afbf7-56c8-4706-87b9-9a8ce2332d05";

test("probe: action-renderer mounts and edit modal opens cleanly", async ({ page }, testInfo) => {
  // Seed view-panel context BEFORE the harness boots so first mount targets it.
  await page.addInitScript((uuid) => {
    localStorage.setItem("harness.ctx", "viewpanel");
    localStorage.setItem("harness.module", "alerts");
    localStorage.setItem("harness.id", uuid);
  }, ALERT_UUID);

  const outDir = testInfo.outputDir;
  const report = await probeWidget(page, "actionRendererWidget", async (p) => {
    await p.locator("#edit-config").click();
    await p.locator("#edit-modal-body").waitFor({ state: "visible", timeout: 15000 });
    await p.locator("#edit-modal-body > [ng-controller], #edit-modal-body [data-ng-controller]")
      .first().waitFor({ state: "attached", timeout: 10000 });
  }, {
    outFile: path.join(outDir, "probe-report.json"),
    screenshotPath: path.join(outDir, "probe-screenshot.png"),
    settleMs: 3000,
  });

  const errs = meaningfulErrors(report);
  if (errs.length) {
    console.log("\n[probe] meaningful errors:\n" + JSON.stringify(errs, null, 2));
  }
  expect(errs).toEqual([]);
});
