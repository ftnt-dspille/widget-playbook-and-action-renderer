"use strict";
// TEMP live smoke for the deployed action-renderer widget (run with E2E_LIVE=1).
// Loads the widget against the real forticloud box on an Alert view-panel
// context and confirms it mounts + the edit wizard opens with no meaningful
// console errors.
//
// DEVKIT DEPENDENCY: this e2e spec only runs inside the fsr-widget-devkit
// checkout (this widget at devkit/widgets-src/<widget>/, sibling
// fortisoar-widget-harness/). `_probe` is reached via the relative path below;
// in a bare clone of this widget repo it won't resolve. Run via the devkit
// Makefile, never standalone. Safe to delete after the live check.

const { test, expect } = require("@playwright/test");
const path = require("path");
const { probeWidget, meaningfulErrors } = require("../../../../fortisoar-widget-harness/tests/e2e/_probe");

// Override with a UUID that exists on your box (records are box-specific).
const ALERT_UUID = process.env.AR_ALERT_UUID || "d18ee22d-7476-4a74-ba7b-f09438bdce5d";

test("live: action-renderer mounts + edit wizard opens on the box", async ({ page }, testInfo) => {
  await page.addInitScript((uuid) => {
    localStorage.setItem("harness.ctx", "viewpanel");
    localStorage.setItem("harness.module", "alerts");
    localStorage.setItem("harness.id", uuid);
  }, ALERT_UUID);

  const outDir = testInfo.outputDir;
  const report = await probeWidget(page, "actionRendererWidget", async (p) => {
    await p.locator("#edit-config").click();
    await p.locator("#edit-modal-body").waitFor({ state: "visible", timeout: 20000 });
    await p.locator("#edit-modal-body > [ng-controller], #edit-modal-body [data-ng-controller]")
      .first().waitFor({ state: "attached", timeout: 15000 });
  }, {
    outFile: path.join(outDir, "ar-live-report.json"),
    screenshotPath: path.join(outDir, "ar-live-screenshot.png"),
    settleMs: 4000,
  });

  const errs = meaningfulErrors(report);
  if (errs.length) console.log("\n[ar-live] errors:\n" + JSON.stringify(errs, null, 2));
  expect(errs).toEqual([]);
});
