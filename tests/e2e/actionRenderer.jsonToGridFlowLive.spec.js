"use strict";
/**
 * LIVE full edit-config flow for the action-renderer widget using the
 * "JSON to Grid - playbook example" playbook as the source (the exact scenario
 * the user hit: Source → Params → Run sample → Output, and the Run sample must
 * actually execute against the box and render output).
 *
 * This playbook is a no-record Manual trigger (noRecordExecution:true) that
 * lives in an unpublished/"Drafts" collection, so its action route is NOT
 * registered — firing it via /api/triggers/1/action/<route> 404s. The widget
 * must classify it as `manual` and run it by UUID via
 * /api/triggers/1/notrigger/<uuid> (what the designer "Run" uses). This spec
 * proves the whole flow end-to-end against the live box.
 *
 * Dashboard context (no record), matching the user's screenshot ("Showing all
 * action-trigger playbooks (no record context on dashboards)").
 *
 * Gated by E2E_LIVE=1 (which also sets FSR_HERMETIC=0 so the proxy reaches the
 * box). The browser only talks to the localhost harness; the harness proxies to
 * the box server-side with its own token, so there is no WAF/UA concern.
 *
 *   cd fortisoar-widget-harness
 *   make test-ar-jtg-flow-live          # exports .env.box (the test box) + runs this spec
 */

const { test, expect } = require("@playwright/test");

const PLAYBOOK_NAME = process.env.AR_PLAYBOOK_NAME || "JSON to Grid - playbook example";

test.describe.configure({ mode: "serial", timeout: 240000 });

function formScope(page) {
  return page.evaluate(() => {
    const form = document.querySelector("#edit-modal-body form");
    if (!form || !window.angular) return null;
    const sc = window.angular.element(form).scope();
    if (!sc) return null;
    return {
      activeStep: sc.activeStep,
      kind: sc.config && sc.config.source && sc.config.source.kind,
      loading: !!sc.playbookListLoading,
      count: Array.isArray(sc.playbooks) ? sc.playbooks.length : -1,
    };
  });
}

test.describe("live: action-renderer edit — JSON to Grid playbook full flow", () => {
  test("pick → run sample (notrigger) → output renders against the box", async ({ page }) => {
    const apiErrors = [];
    const consoleErrors = [];
    const triggerCalls = [];
    page.on("response", (r) => {
      try {
        const u = r.url();
        if (/\/api\/triggers\/1\//.test(u)) triggerCalls.push(`HTTP ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
        if (r.status() >= 400 && /\/api\//.test(u)) apiErrors.push(`HTTP ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
      } catch (_) { /* gone */ }
    });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    // Dashboard context (no record) — the user's scenario.
    await page.addInitScript(() => {
      localStorage.setItem("harness.ctx", "dashboard");
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    // Ensure the action-renderer widget is selected.
    await page.evaluate(() => {
      const sel = document.getElementById("widget-select");
      if (sel && !(sel.value || "").toLowerCase().includes("action")) {
        for (const o of sel.options) {
          if ((o.value || "").toLowerCase().includes("action")) {
            sel.value = o.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      }
    });
    await page.waitForTimeout(2500);

    // Open the edit modal and switch the source to Playbook.
    await page.locator("#edit-config").click();
    await page.waitForSelector("#edit-modal-body form", { timeout: 20000 });
    await page.locator('#edit-modal-body button:has-text("Playbook")').click();

    // Wait for the (dashboard → show-all) playbook list to load.
    {
      const deadline = Date.now() + 90000;
      let s = null;
      while (Date.now() < deadline) {
        s = await formScope(page);
        if (s && !s.loading && s.count > 0) break;
        await page.waitForTimeout(500);
      }
      expect(s, "playbook list should load").toBeTruthy();
      expect(s.count, "dashboard show-all list should be non-empty").toBeGreaterThan(0);
    }

    // Pick the JSON to Grid playbook by name and run onPlaybookPicked (ui-select
    // ng-model doesn't bind in the harness shell, so drive the handler directly).
    const picked = await page.evaluate((name) => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const pb = (sc.playbooks || []).find((p) => (p.name || "").trim() === name) ||
        (sc.playbooks || []).find((p) => /JSON to Grid/i.test(p.name || ""));
      if (!pb) return { found: false, sample: (sc.playbooks || []).slice(0, 5).map((p) => p.name) };
      sc.picks.playbookPicked = pb;
      return Promise.resolve(sc.onPlaybookPicked()).then(() => {
        const src = sc.config && sc.config.source;
        return {
          found: true, name: pb.name, kind: src && src.kind, uuid: src && src.uuid,
          route: src && src.route, triggerType: src && src.triggerType,
          noRecordExecution: src && src.noRecordExecution,
        };
      });
    }, PLAYBOOK_NAME);
    console.log("[ar-jtg-live] picked =", JSON.stringify(picked));
    expect(picked.found, `playbook "${PLAYBOOK_NAME}" should be in the list`).toBe(true);
    expect(picked.uuid, "source should carry the playbook uuid").toBeTruthy();
    // The fix: a no-record (noRecordExecution) playbook classifies as MANUAL so
    // it runs by UUID via notrigger, NOT action/<route> (which 404s here).
    expect(picked.triggerType, "JSON to Grid (noRecordExecution) should classify as manual").toBe("manual");

    // ── Step 3: Run sample against the live box ──────────────────────────────
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      sc.activeStep = 3;
      sc.$apply();
    });
    const sample = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      sc.runWithCurrentRecord();
      return new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (!sc.executing && (sc.executedSample !== null || sc.lastExecutionError || Date.now() - t0 > 120000)) {
            clearInterval(iv);
            resolve({
              error: sc.lastExecutionError || null,
              elapsed: sc.executeElapsedMs,
              hasSample: sc.executedSample !== null && sc.executedSample !== undefined,
              sampleKeys: sc.executedSample && typeof sc.executedSample === "object" ? Object.keys(sc.executedSample) : null,
              gridDataLen: sc.executedSample && sc.executedSample.grid_data ? sc.executedSample.grid_data.length : null,
            });
          }
        }, 500);
      });
    });
    console.log("[ar-jtg-live] run sample =", JSON.stringify(sample));
    console.log("[ar-jtg-live] trigger calls =", JSON.stringify(triggerCalls));
    expect(sample.error, "Run sample must not error").toBeNull();
    expect(sample.hasSample, "Run sample must produce an executed sample").toBe(true);
    // The trigger must have gone to notrigger (by uuid), not action — and succeeded.
    expect(triggerCalls.some((c) => /notrigger\//.test(c) && /^HTTP 2/.test(c)),
      `the run should POST notrigger/<uuid> with a 2xx (got ${JSON.stringify(triggerCalls)})`).toBe(true);
    expect(triggerCalls.some((c) => /\/action\//.test(c)),
      "the run must NOT hit the action/<route> endpoint for this no-record playbook").toBe(false);
    // The JSON to Grid sample playbook returns a grid_data array.
    expect(sample.sampleKeys, "sample should be an object").toBeTruthy();

    // ── Step 4: Output mode = table, set a root path, and save ───────────────
    const saved = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      sc.activeStep = 4;
      sc.config.output = sc.config.output || {};
      sc.config.output.mode = "table";
      sc.config.output.table = sc.config.output.table || {};
      // grid_data is the natural root path for this playbook's output.
      if (sc.executedSample && sc.executedSample.grid_data) sc.config.output.table.rootPath = "grid_data";
      sc.$apply();
      return { mode: sc.config.output.mode, rootPath: sc.config.output.table && sc.config.output.table.rootPath };
    });
    console.log("[ar-jtg-live] output config =", JSON.stringify(saved));
    expect(saved.mode).toBe("table");

    const benign = /favicon|ResizeObserver|Non-Error promise rejection|referrer policy|sandbox|lazyService failed for playbookService|getActionPlaybooks/i;
    const meaningful = [...apiErrors.filter((t) => !/notrigger/.test(t)), ...consoleErrors.filter((t) => !benign.test(t))];
    if (meaningful.length) console.log("[ar-jtg-live] errors:\n" + meaningful.join("\n"));
    expect(meaningful, "no meaningful console/api errors during the full flow").toEqual([]);
  });
});
