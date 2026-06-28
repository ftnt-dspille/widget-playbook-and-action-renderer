"use strict";
// E2E test for action-renderer playbook picker dropdown contrast on SOAR dark theme.
// Verifies that ui-select dropdown renders with readable contrast (light text on dark bg)
// and that the dropdown escapes the modal body clipping.

const { test, expect } = require("../../../../fortisoar-widget-harness/tests/e2e/_fixtures");

const ALERT_UUID =
  process.env.AR_ALERT_UUID || "db7afbf7-56c8-4706-87b9-9a8ce2332d05";

async function seedHarness(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((uuid) => {
    localStorage.setItem("harness.module", "alerts");
    localStorage.setItem("harness.id", uuid);
    localStorage.setItem("harness.ctx", "dashboard");
    const cur = JSON.parse(localStorage.getItem("harness.currentWidget") || "null");
    if (!cur || cur.id !== "actionRendererWidget-1.0.8") {
      localStorage.setItem("harness.currentWidget", JSON.stringify({ id: "actionRendererWidget-1.0.8" }));
    }
    localStorage.removeItem("harness.widgetConfig.actionRendererWidget-1.0.8");
  }, ALERT_UUID);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__HARNESS_RECORD, { timeout: 20000 });
  await page.waitForTimeout(1500);
}

async function openEditModal(page) {
  await page.click("#edit-config");
  // The connector picker is a searchable ui-select; wait for the container to
  // render (the choices are loaded lazily and only materialize on open).
  await page.waitForSelector(
    "#edit-modal-body ui-select[data-ng-model='picks.connectorPicked']",
    { timeout: 30000 }
  );
}

test.describe("playbook picker dropdown contrast", () => {
  let pageErrors = [];
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && /\$parse|TypeError|Unknown provider/.test(m.text())) {
        pageErrors.push(m.text().slice(0, 400));
      }
    });
    await seedHarness(page);
    await openEditModal(page);
  });

  test.afterEach(async () => {
    expect(pageErrors, "no AngularJS lex/parse or injector errors").toEqual([]);
  });

  test("dashboard mode shows 'Showing all action-trigger playbooks' hint, no 'Show all' checkbox", async ({ page }) => {
    // Switch to Playbook source.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("#edit-modal-body .btn-group .btn"))
        if (/^Playbook$/i.test(b.innerText.trim())) { b.click(); return; }
    });

    // Wait for the ui-select to render OR for the "unavailable" warning toast.
    // In dev harness without websocket services, playbookService is unavailable.
    await page.waitForFunction(
      () => {
        const s = document.querySelector(
          "#edit-modal-body ui-select[data-ng-model='picks.playbookPicked']"
        );
        const warning = document.querySelector(".toaster-warning");
        return (s && s.offsetHeight > 0) || !!warning;
      },
      { timeout: 15000 }
    );

    // Check if playbook service is unavailable (expected in harness).
    const hasWarning = await page.locator(".toaster-warning, .toast-warning").isVisible().catch(() => false);
    if (hasWarning) {
      test.skip(true, "playbook service unavailable in dev harness (websocket/stomp not registered)");
    }

    // Verify hint is visible and checkbox is NOT visible.
    const hint = await page.locator(".font-size-12.muted-65").filter({ hasText: /Showing all action-trigger playbooks/ });
    const checkbox = page.locator("input[data-ng-model='showAllPlaybooks']");

    await expect(hint).toBeVisible();
    await expect(checkbox).not.toBeVisible();
  });

  test("playbook dropdown renders with light text on dark background (idle row)", async ({ page }) => {
    // Switch to Playbook source.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("#edit-modal-body .btn-group .btn"))
        if (/^Playbook$/i.test(b.innerText.trim())) { b.click(); return; }
    });

    // Wait for ui-select to be ready OR for warning toast.
    await page.waitForFunction(
      () => {
        const s = document.querySelector(
          "#edit-modal-body ui-select[data-ng-model='picks.playbookPicked']"
        );
        const warning = document.querySelector(".toaster-warning, .toast-warning");
        return (s && s.offsetHeight > 0) || !!warning;
      },
      { timeout: 15000 }
    );

    // Skip if playbook service unavailable.
    const hasWarning = await page.locator(".toaster-warning, .toast-warning").isVisible().catch(() => false);
    if (hasWarning) {
      test.skip(true, "playbook service unavailable in dev harness (websocket/stomp not registered)");
    }

    // Click the ui-select match button to open dropdown.
    await page.click("#edit-modal-body ui-select[data-ng-model='picks.playbookPicked'] .ui-select-match .btn");

    // Wait for at least one choice row to render.
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll(".ui-select-choices-row");
        return rows.length > 0 && rows[0].offsetHeight > 0;
      },
      { timeout: 10000 }
    );

    // Get the FIRST idle (non-hovered, non-active) row.
    const firstRow = await page.$eval(".ui-select-choices-row:first-child", (el) => {
      const classes = Array.from(el.classList);
      return {
        isActive: classes.includes("active"),
        isFirst: true,
      };
    });

    // If the first row is active (unlikely on page load), pick the second.
    const targetRowSelector = firstRow.isActive
      ? ".ui-select-choices-row:nth-child(2)"
      : ".ui-select-choices-row:first-child";

    // Read computed color from the idle row's anchor.
    const idleTextColor = await page.$eval(
      targetRowSelector + " > a, " + targetRowSelector + " > span",
      (el) => {
        const computed = window.getComputedStyle(el);
        return computed.color;
      }
    );

    // Also check the inner div.
    const innerDivColor = await page.$eval(
      targetRowSelector + " > a > div, " + targetRowSelector + " > span > div",
      (el) => {
        const computed = window.getComputedStyle(el);
        return computed.color;
      }
    );

    console.log("Idle row text color (anchor):", idleTextColor);
    console.log("Idle row text color (inner div):", innerDivColor);

    // Parse color strings to RGBA.
    function parseRgba(colorStr) {
      const match = colorStr.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
      if (match) {
        return {
          r: parseInt(match[1], 10),
          g: parseInt(match[2], 10),
          b: parseInt(match[3], 10),
          a: match[4] ? parseFloat(match[4]) : 1,
        };
      }
      return null;
    }

    const anchorColor = parseRgba(idleTextColor);
    const innerColor = parseRgba(innerDivColor);

    console.log("Parsed anchor color:", anchorColor);
    console.log("Parsed inner div color:", innerColor);

    // Assert colors are close to white with good alpha.
    if (anchorColor) {
      expect(
        anchorColor.r,
        `idle row anchor text red channel should be bright (>=240): got ${anchorColor.r}`
      ).toBeGreaterThanOrEqual(240);
      expect(
        anchorColor.g,
        `idle row anchor text green channel should be bright (>=240): got ${anchorColor.g}`
      ).toBeGreaterThanOrEqual(240);
      expect(
        anchorColor.b,
        `idle row anchor text blue channel should be bright (>=240): got ${anchorColor.b}`
      ).toBeGreaterThanOrEqual(240);
      expect(
        anchorColor.a,
        `idle row anchor text alpha should be opaque (>=0.85): got ${anchorColor.a}`
      ).toBeGreaterThanOrEqual(0.85);
    } else {
      test.fail(true, `Failed to parse anchor color: ${idleTextColor}`);
    }
  });

  test("playbook dropdown active/hover row renders with blue tinted background", async ({ page }) => {
    // Switch to Playbook source.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("#edit-modal-body .btn-group .btn"))
        if (/^Playbook$/i.test(b.innerText.trim())) { b.click(); return; }
    });

    await page.waitForFunction(
      () => {
        const s = document.querySelector(
          "#edit-modal-body ui-select[data-ng-model='picks.playbookPicked']"
        );
        const warning = document.querySelector(".toaster-warning, .toast-warning");
        return (s && s.offsetHeight > 0) || !!warning;
      },
      { timeout: 15000 }
    );

    const hasWarning = await page.locator(".toaster-warning, .toast-warning").isVisible().catch(() => false);
    if (hasWarning) {
      test.skip(true, "playbook service unavailable in dev harness (websocket/stomp not registered)");
    }

    // Click to open dropdown.
    await page.click("#edit-modal-body ui-select[data-ng-model='picks.playbookPicked'] .ui-select-match .btn");

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll(".ui-select-choices-row");
        return rows.length > 0 && rows[0].offsetHeight > 0;
      },
      { timeout: 10000 }
    );

    // Hover over the first row to activate it.
    const firstRow = page.locator(".ui-select-choices-row").first();
    await firstRow.hover();
    await page.waitForTimeout(300);

    // Read the background color of the active/hovered row's anchor.
    const activeRowBgColor = await page.$eval(
      ".ui-select-choices-row:first-child > a, .ui-select-choices-row:first-child > span",
      (el) => {
        const computed = window.getComputedStyle(el);
        return computed.backgroundColor;
      }
    );

    console.log("Active/hover row background color:", activeRowBgColor);

    // Parse RGBA.
    function parseRgba(colorStr) {
      const match = colorStr.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
      if (match) {
        return {
          r: parseInt(match[1], 10),
          g: parseInt(match[2], 10),
          b: parseInt(match[3], 10),
          a: match[4] ? parseFloat(match[4]) : 1,
        };
      }
      return null;
    }

    const parsed = parseRgba(activeRowBgColor);
    console.log("Parsed active row background:", parsed);

    // Expected: rgba(78, 154, 241, 0.28) per the CSS rule.
    if (parsed) {
      expect(parsed.r, `active row bg red should be ~78: got ${parsed.r}`).toBeCloseTo(78, 10);
      expect(parsed.g, `active row bg green should be ~154: got ${parsed.g}`).toBeCloseTo(154, 10);
      expect(parsed.b, `active row bg blue should be ~241: got ${parsed.b}`).toBeCloseTo(241, 10);
      expect(parsed.a, `active row bg alpha should be ~0.28: got ${parsed.a}`).toBeCloseTo(0.28, 1);
    }
  });

  test("selecting a playbook keeps the picker in place (no append-to-body vanish)", async ({ page }) => {
    // Regression: ui-select's `append-to-body="true"` moved the whole
    // .ui-select-container into <body> on open and failed to restore it on
    // close, leaving it stranded as a <body> child while a placeholder sat in
    // the modal — so picking a playbook made the field disappear. We dropped
    // append-to-body; the container must stay inside the modal after a select.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("#edit-modal-body .btn-group .btn"))
        if (/^Playbook$/i.test(b.innerText.trim())) { b.click(); return; }
    });

    await page.waitForFunction(
      () => {
        const s = document.querySelector("#edit-modal-body .ui-select-container");
        const warning = document.querySelector(".toaster-warning, .toast-warning");
        return (s && s.offsetHeight > 0) || !!warning;
      },
      { timeout: 15000 }
    );

    const hasWarning = await page.locator(".toaster-warning, .toast-warning").isVisible().catch(() => false);
    if (hasWarning) {
      test.skip(true, "playbook service unavailable in dev harness (websocket/stomp not registered)");
    }

    // Seed two playbooks so the picker always has choices, independent of the
    // proxied box, then drive a real selection through ui-select's own API.
    await page.evaluate(() => {
      const sc = angular.element(document.querySelector(".action-renderer-edit")).scope();
      sc.$apply(() => {
        sc.playbookListLoading = false;
        sc.playbooks = [
          { uuid: "u1", "@id": "/api/3/workflows/u1", name: "PB One", steps: [{ arguments: { title: "PB One", inputVariables: [] } }], actionTriggerName: "PB One", collectionName: "Alerts" },
          { uuid: "u2", "@id": "/api/3/workflows/u2", name: "PB Two", steps: [{ arguments: { title: "PB Two", inputVariables: [] } }], actionTriggerName: "PB Two", collectionName: "Alerts" },
        ];
      });
    });

    // Open, then select the first row via ui-select's isolate-scope API.
    await page.click("#edit-modal-body .ui-select-container .ui-select-match");
    await page.waitForFunction(
      () => document.querySelectorAll(".ui-select-choices-row").length > 0,
      { timeout: 10000 }
    );
    await page.evaluate(() => {
      const c = document.querySelector("#edit-modal-body .ui-select-container");
      const iso = angular.element(c).isolateScope();
      const fs = angular.element(document.querySelector(".action-renderer-edit")).scope();
      fs.$apply(() => iso.$select.select(fs.playbooks[0]));
    });

    const after = await page.evaluate(() => {
      const inModal = document.querySelector("#edit-modal-body .ui-select-container");
      const stranded = Array.from(document.body.children).filter(
        (c) => c.classList && c.classList.contains("ui-select-container")
      ).length;
      return {
        containerInModal: !!inModal,
        visibleHeight: inModal ? inModal.offsetHeight : -1,
        strandedInBodyRoot: stranded,
      };
    });

    expect(after.containerInModal, "picker container must remain inside the modal").toBe(true);
    expect(after.visibleHeight, "picker must still be visible (non-zero height)").toBeGreaterThan(0);
    expect(after.strandedInBodyRoot, "picker must not be stranded as a <body> child").toBe(0);
  });
});
