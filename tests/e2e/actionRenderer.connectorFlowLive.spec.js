"use strict";
/**
 * LIVE full edit-config flow for the action-renderer widget using a real
 * CONNECTOR operation as the source (the other half of the source matrix; the
 * playbook branch is covered by actionRenderer.{playbookListing,jsonToGridFlow}Live).
 *
 * Drives: Source=connector → pick connector → pick operation → config auto/forced
 * → Run sample (real connector execution against the box) → Output=table renders.
 *
 * Defaults target MITRE ATT&CK `get_mitre_data_sample` — a self-contained op
 * backed by a bundled dataset (no external endpoint), so the positive path is
 * deterministic regardless of lab integration health. For the wide-table case
 * (fix #3), override to a connector that reaches a live target:
 *   AR_CONNECTOR=fortigate-firewall  AR_OPERATION=get_addresses
 * A connector whose endpoint is unreachable yields an [[AR-ENV-SKIP]] (the
 * widget flow + error path are still asserted).
 *
 * Gated by E2E_LIVE=1 (sets FSR_HERMETIC=0 so the proxy reaches the box). The
 * browser only talks to the localhost harness; the harness proxies to the box
 * server-side with its own token, so there is no WAF/UA concern.
 *
 *   cd fortisoar-widget-harness
 *   make test-ar-connector-live          # exports .env.box (the test box) + runs this spec
 */

const { test, expect } = require("@playwright/test");

const CONNECTOR = process.env.AR_CONNECTOR || "mitre-attack";
const OPERATION = process.env.AR_OPERATION || "get_mitre_data_sample";

test.describe.configure({ mode: "serial", timeout: 240000 });

const FORM = "#edit-modal-body form";

function evalScope(page, fn, arg) {
  return page.evaluate(
    ({ sel, body, a }) => {
      const form = document.querySelector(sel);
      if (!form || !window.angular) return null;
      const sc = window.angular.element(form).scope();
      if (!sc) return null;
      // eslint-disable-next-line no-new-func
      return Function("sc", "a", body)(sc, a);
    },
    { sel: FORM, body: `return (${fn.toString()})(sc, a);`, a: arg }
  );
}

test.describe("live: action-renderer edit — connector operation full flow", () => {
  test("pick connector → operation → run sample → table output (vs the box)", async ({ page }) => {
    const apiErrors = [];
    const consoleErrors = [];
    const opCalls = [];
    page.on("response", (r) => {
      try {
        const u = r.url();
        if (/\/api\/integration\/(execute|connectors)/.test(u)) opCalls.push(`HTTP ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
        if (r.status() >= 400 && /\/api\//.test(u)) apiErrors.push(`HTTP ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
      } catch (_) { /* gone */ }
    });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await page.addInitScript(() => localStorage.setItem("harness.ctx", "dashboard"));
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

    // Open the edit modal (connector is the default source kind).
    await page.locator("#edit-config").click();
    await page.waitForSelector(FORM, { timeout: 20000 });
    await evalScope(page, (sc) => { sc.config.source = sc.config.source || {}; sc.config.source.kind = "connector"; sc.$apply(); });

    // ── Wait for the connector list to load ──────────────────────────────────
    {
      const deadline = Date.now() + 90000;
      let s = null;
      while (Date.now() < deadline) {
        s = await evalScope(page, (sc) => ({ loading: !!sc.connectorListLoading, count: Array.isArray(sc.connectors) ? sc.connectors.length : -1 }));
        if (s && !s.loading && s.count > 0) break;
        await page.waitForTimeout(500);
      }
      expect(s, "connector list should load").toBeTruthy();
      expect(s.count, "connector list should be non-empty").toBeGreaterThan(0);
    }

    // ── Pick the connector ───────────────────────────────────────────────────
    const picked = await evalScope(page, (sc, name) => {
      const c = (sc.connectors || []).find((x) => ((x.name || "") + " " + (x.label || "")).toLowerCase().includes(name.toLowerCase()));
      if (!c) return { found: false, sample: (sc.connectors || []).slice(0, 8).map((x) => x.name) };
      sc.picks.connectorPicked = c;
      sc.onConnectorPicked();
      return { found: true, name: c.name, version: c.version };
    }, CONNECTOR);
    console.log("[ar-conn-live] picked connector =", JSON.stringify(picked));
    expect(picked.found, `connector matching "${CONNECTOR}" should be installed`).toBe(true);

    // ── Wait for connectorDetails (operations + configuration) ───────────────
    {
      const deadline = Date.now() + 90000;
      let s = null;
      while (Date.now() < deadline) {
        s = await evalScope(page, (sc) => {
          const d = sc.connectorDetails;
          const cfgs = d && (d.configuration || d.configurations) || [];
          return {
            loading: !!sc.connectorLoading,
            hasDetails: !!d,
            ops: d && Array.isArray(d.operations) ? d.operations.length : -1,
            cfgs: cfgs.length,
            cfgSet: !!(sc.config.source && sc.config.source.config),
          };
        });
        if (s && !s.loading && s.hasDetails && s.ops > 0) break;
        await page.waitForTimeout(500);
      }
      console.log("[ar-conn-live] connectorDetails =", JSON.stringify(s));
      expect(s.hasDetails, "connector details should load").toBe(true);
      expect(s.ops, "connector should expose operations").toBeGreaterThan(0);
    }

    // ── Pick the operation; force a config if not auto-selected ──────────────
    const op = await evalScope(page, (sc, opName) => {
      const d = sc.connectorDetails;
      const cfgs = (d && (d.configuration || d.configurations)) || [];
      if (!sc.config.source.config && cfgs.length) sc.config.source.config = cfgs[0].config_id;
      const match = (d.operations || []).find((o) => o.operation === opName) ||
        (d.operations || []).find((o) => /get[_-]?address/i.test(o.operation || ""));
      if (!match) return { found: false, sample: (d.operations || []).slice(0, 10).map((o) => o.operation) };
      sc.picks.operationPicked = match;
      sc.onOperationPicked();
      sc.$apply();
      const src = sc.config.source;
      return {
        found: true, operation: src.operation, configRequired: src.configRequired,
        config: src.config, paramCount: (src.parameters || []).length, canAdvance: !!sc.canAdvanceFromSource,
      };
    }, OPERATION);
    console.log("[ar-conn-live] picked op =", JSON.stringify(op));
    expect(op.found, `operation "${OPERATION}" should exist on the connector`).toBe(true);
    expect(op.operation, "source.operation should be set").toBeTruthy();
    // Config requirement satisfied: either a config_id is set, or the op needs none.
    expect(Boolean(op.config) || op.configRequired === false, "a config must be selected (or not required)").toBe(true);

    // ── Step 3: Run sample against the live connector ────────────────────────
    await evalScope(page, (sc) => { sc.activeStep = 3; sc.$apply(); });
    const sample = await page.evaluate((sel) => {
      const sc = window.angular.element(document.querySelector(sel)).scope();
      sc.runWithCurrentRecord();
      return new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (!sc.executing && (sc.executedSample !== null || sc.lastExecutionError || Date.now() - t0 > 120000)) {
            clearInterval(iv);
            const s = sc.executedSample;
            resolve({
              error: sc.lastExecutionError || null,
              elapsed: sc.executeElapsedMs,
              hasSample: s !== null && s !== undefined,
              topKeys: s && typeof s === "object" ? Object.keys(s) : null,
              resultsLen: s && s.data && Array.isArray(s.data.results) ? s.data.results.length : (Array.isArray(s) ? s.length : null),
            });
          }
        }, 500);
      });
    }, FORM);
    console.log("[ar-conn-live] run sample =", JSON.stringify(sample));
    console.log("[ar-conn-live] op calls =", JSON.stringify(opCalls));

    // The widget MUST have dispatched the execute call to the box regardless of
    // whether the lab connector's endpoint is reachable.
    expect(opCalls.some((c) => /\/integration\/execute/.test(c)),
      `widget must POST /integration/execute (got ${JSON.stringify(opCalls)})`).toBe(true);

    // Two-tier: a connector-reachability/credential error is an ENV issue (the
    // lab integration target is down/misconfigured), NOT a widget bug — same
    // philosophy as the live-sweep [[SWEEP-ENV-SKIP]]. In that case we still
    // assert the widget surfaced the error cleanly (error path, no crash) and
    // skip the positive-render assertions.
    const ENV_ERR = /invalid endpoint or credentials|unable to connect|connection (refused|timed out|error)|max retries|name or service not known|unreachable|certificate|getaddrinfo|ssl/i;
    if (!sample.hasSample && sample.error && ENV_ERR.test(sample.error)) {
      console.log(`[ar-conn-live] [[AR-ENV-SKIP]] connector "${CONNECTOR}" not reachable on the box: ${sample.error}`);
      // The error must have been surfaced to the user via the widget's error path.
      const errState = await evalScope(page, (sc) => ({ executing: !!sc.executing, lastErr: sc.lastExecutionError || null }));
      expect(errState.executing, "widget should not be stuck executing after a connector error").toBe(false);
      expect(errState.lastErr, "widget should surface the connector error via lastExecutionError").toBeTruthy();
      test.skip(true, `connector ${CONNECTOR} unreachable on box (env) — widget flow + error path verified`);
      return;
    }

    // ── Positive path: the connector returned data ───────────────────────────
    expect(sample.error, "Run sample must not error").toBeNull();
    expect(sample.hasSample, "Run sample must produce an executed sample").toBe(true);
    expect(sample.topKeys, "sample should be a non-empty object").toBeTruthy();

    // ── Step 4: Output mode = table, auto-pick a sensible root path, save ─────
    const saved = await evalScope(page, (sc) => {
      sc.activeStep = 4;
      sc.config.output = sc.config.output || {};
      sc.config.output.mode = "table";
      sc.config.output.table = sc.config.output.table || {};
      const s = sc.executedSample;
      if (s && s.data && Array.isArray(s.data.results)) sc.config.output.table.rootPath = "data.results";
      sc.config.output.table.mode = "auto";
      sc.$apply();
      return { mode: sc.config.output.mode, rootPath: sc.config.output.table.rootPath, tableMode: sc.config.output.table.mode };
    });
    console.log("[ar-conn-live] output config =", JSON.stringify(saved));
    expect(saved.mode).toBe("table");

    const benign = /favicon|ResizeObserver|Non-Error promise rejection|referrer policy|sandbox|lazyService|getActionPlaybooks/i;
    const meaningful = [...apiErrors.filter((t) => !/integration\/execute/.test(t)), ...consoleErrors.filter((t) => !benign.test(t))];
    if (meaningful.length) console.log("[ar-conn-live] errors:\n" + meaningful.join("\n"));
    expect(meaningful, "no meaningful console/api errors during the connector flow").toEqual([]);
  });
});
