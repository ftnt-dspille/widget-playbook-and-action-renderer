"use strict";
/**
 * LIVE real-SOAR-UI test for the action-renderer widget.
 *
 * Unlike the harness mock (where `cs-connector-field-renderer` is stubbed), this
 * drives the ACTUAL deployed FortiSOAR app: it places the action-renderer widget
 * on the alerts record-detail template via the platform API, opens a real alert
 * record in a WAF-safe desktop-UA browser, and asserts the widget actually mounts
 * and renders on the real page. That is the one thing the mock tier can't prove.
 *
 * Gated: only runs with FSRPB_LIVE_UI=1 (it touches the box + a desktop browser).
 * Cleanup (template restore) is mandatory and idempotent — a crashed run
 * self-heals on the next add/remove.
 *
 * Run (from the devkit root):
 *   make test-e2e-spec SPEC=widgets-src/widget-action-renderer/tests/e2e/actionRenderer.liveTemplate.spec.js
 *
 * DEVKIT DEPENDENCY: this e2e spec lives with the widget source but only runs
 * inside the fsr-widget-devkit checkout (this widget at
 * devkit/widgets-src/<widget>/, sibling fortisoar-widget-harness/). It reaches
 * the harness's live infra (`viewTemplate`, `soarBrowser`) via the relative
 * paths below; in a bare clone of this widget repo they won't resolve. The
 * harness "widgets" Playwright project (testDir = canonicalized widgets-src)
 * discovers it; run via the devkit Makefile, never standalone.
 */

const { test, expect } = require("@playwright/test");
const { makeViewTemplateClient } = require("../../../../fortisoar-widget-harness/tests/live/lib/viewTemplate");
const { launchSoarSession, openRecord } = require("../../../../fortisoar-widget-harness/lib/soarBrowser");

const RUN_LIVE = process.env.FSRPB_LIVE_UI === "1" || process.env.E2E_LIVE === "1";
const MODULE = process.env.AR_MODULE || "alerts";
// A real alert that exists on the box (records are box-specific; override via env).
const ALERT_UUID = process.env.AR_ALERT_UUID || "d18ee22d-7476-4a74-ba7b-f09438bdce5d";

// These take a real browser through a real login + record render.
test.describe.configure({ mode: "serial", timeout: 180000 });

(RUN_LIVE ? test.describe : test.describe.skip)("live: action-renderer on a real record page", () => {
  let vt;
  let placed = null; // { uuid, version } once added, for cleanup

  test.beforeAll(async () => {
    vt = await makeViewTemplateClient();
    const version = await vt.resolveInstalledActionRendererVersion();
    expect(version, "action-renderer widget must be installed on the box").toBeTruthy();
    const res = await vt.addActionRendererWidget(MODULE, {
      version,
      config: { title: "AR Live E2E" },
    });
    placed = { uuid: res.uuid, version };
    expect(await vt.hasActionRendererWidget(MODULE)).toBe(true);
  });

  test.afterAll(async () => {
    // ALWAYS restore the template — it's the production detail view.
    if (vt) await vt.removeActionRendererWidget(MODULE).catch(() => {});
  });

  test("mounts + renders on the real record detail page", async () => {
    const s = await launchSoarSession();
    try {
      await openRecord(s.page, s.base, MODULE, ALERT_UUID, { settleMs: 12000 });

      // The widget root. Published SOAR mounts the widget WITHOUT exposing an
      // ng-controller attribute in the DOM (it strips the dev `…DevCtrl` wrapper),
      // so we prove the controller is live by asserting its rendered, scope-driven
      // output rather than the controller name.
      const root = s.page.locator(".action-renderer-widget").first();
      await expect(root, "widget container should render on the record page").toBeVisible({ timeout: 30000 });

      // Body rendered (not a blank/error mount).
      const body = s.page.locator(".action-renderer-body").first();
      await expect(body, "widget body should render").toBeVisible({ timeout: 15000 });

      // Controller scope is alive: the `v{{ widgetVersion }}` binding interpolated
      // (proves the controller ran, not just static template HTML), and the
      // unconfigured widget shows its "not configured" banner (the default ng-if
      // branch for a freshly-placed cell with no source).
      await expect(
        root.locator(`text=/v${placed.version.replace(/\./g, "\\.")}/`),
        "widgetVersion binding should interpolate (controller is live)"
      ).toBeVisible({ timeout: 15000 });
      await expect(
        root.getByText(/not configured/i),
        "freshly-placed widget should show the unconfigured banner"
      ).toBeVisible({ timeout: 15000 });

      const errs = s.errors.meaningful();
      if (errs.length) console.log("[ar-liveTemplate] errors:\n" + errs.join("\n"));
      expect(errs, "no meaningful console/api errors on the record page").toEqual([]);
    } finally {
      await s.close();
    }
  });
});

// ── Connector → table end-to-end ────────────────────────────────────────────
// Configures the widget with a REAL read-only connector action and asserts it
// runs against the live box and renders a table — and that a WIDE table scrolls
// INSIDE the widget instead of overflowing the page (customer fix #3). Defaults
// target the FortiGate `get_addresses` op on the test box; override via
// env for another box/connector. Skips unless a config id is supplied (it's
// box-specific) — keeps the suite green on boxes without that connector.
const FG = {
  connector: process.env.AR_CONNECTOR || "fortigate-firewall",
  version: process.env.AR_CONNECTOR_VERSION || "5.4.0",
  operation: process.env.AR_OPERATION || "get_addresses",
  configId: process.env.AR_CONFIG_ID || "",
  rootPath: process.env.AR_TABLE_ROOTPATH || "results",
};
const RUN_TABLE = RUN_LIVE && !!FG.configId;

(RUN_TABLE ? test.describe : test.describe.skip)(
  "live: action-renderer runs a connector action and renders a table",
  () => {
    let vt;
    test.beforeAll(async () => {
      vt = await makeViewTemplateClient();
      const version = await vt.resolveInstalledActionRendererVersion();
      expect(version, "widget must be installed").toBeTruthy();
      await vt.addActionRendererWidget(MODULE, {
        version,
        config: {
          title: `${FG.connector} ${FG.operation}`,
          source: {
            kind: "connector",
            name: FG.connector,
            version: FG.version,
            operation: FG.operation,
            config: FG.configId,
          },
          params: {},
          output: { mode: "table", table: { rootPath: FG.rootPath, mode: "auto", stickyHeader: true } },
        },
      });
    });

    test.afterAll(async () => {
      if (vt) await vt.removeActionRendererWidget(MODULE).catch(() => {});
    });

    test(`runs ${FG.connector}/${FG.operation} and renders a non-overflowing table`, async () => {
      const s = await launchSoarSession();
      try {
        await openRecord(s.page, s.base, MODULE, ALERT_UUID, { settleMs: 18000 });
        await s.page.waitForTimeout(6000); // connector exec + table build
        const root = s.page.locator(".action-renderer-widget").first();
        await expect(root).toBeVisible({ timeout: 30000 });
        await expect(
          root.locator(".action-renderer-table"),
          "the connector result should render as a table"
        ).toBeVisible({ timeout: 30000 });

        const m = await s.page.evaluate(() => {
          const r = document.querySelector(".action-renderer-widget");
          const t = r.querySelector(".action-renderer-table");
          const wrap = r.querySelector(".action-renderer-table-wrap");
          return {
            headerCount: t.querySelectorAll("thead th, thead td").length,
            bodyRows: t.querySelectorAll("tbody tr").length,
            error: r.querySelector(".alert-danger") ? r.querySelector(".alert-danger").innerText.trim() : null,
            widgetClientW: r.clientWidth,
            widgetScrollW: r.scrollWidth,
            wrapScrollW: wrap ? wrap.scrollWidth : 0,
          };
        });
        expect(m.error, "connector action should not error").toBeNull();
        expect(m.headerCount, "table should have columns").toBeGreaterThan(1);
        expect(m.bodyRows, "table should have data rows").toBeGreaterThan(0);
        // Customer fix #3: even when the table content is wider than the widget
        // (wrap scrolls internally), the WIDGET must not overflow the page.
        expect(
          m.widgetScrollW,
          "widget must not overflow its own width (wide table scrolls inside)"
        ).toBeLessThanOrEqual(m.widgetClientW + 2);
      } finally {
        await s.close();
      }
    });
  }
);

// ── Generic (manual-trigger) playbook → output renders ──────────────────────
// Configures the widget with a kind:"playbook", triggerType:"manual" source and
// asserts the view panel actually FIRES the playbook via /api/triggers/1/
// notrigger/<uuid> (NOT the action endpoint) and renders its output. This is the
// user-reported case: a generic playbook ("query critical" on the test box), not a record-
// scoped action trigger. Defaults to "query critical" (uuid below — confirmed
// safe to run repeatedly: it queries uptime + sets vars, no mutation). Override
// via AR_PLAYBOOK_UUID. Runs under FSRPB_LIVE_UI=1 / E2E_LIVE=1 since it executes
// a REAL playbook on the box.
const PB = {
  uuid: process.env.AR_PLAYBOOK_UUID || "9ce6f46f-29f2-43fd-8a4e-fb66cadf4450",
  name: process.env.AR_PLAYBOOK_NAME || "query critical",
};
const RUN_PB = RUN_LIVE && !!PB.uuid;

(RUN_PB ? test.describe : test.describe.skip)(
  "live: action-renderer fires a generic (manual-trigger) playbook and renders output",
  () => {
    let vt;
    test.beforeAll(async () => {
      vt = await makeViewTemplateClient();
      const version = await vt.resolveInstalledActionRendererVersion();
      expect(version, "widget must be installed").toBeTruthy();
      await vt.addActionRendererWidget(MODULE, {
        version,
        config: {
          title: `Playbook: ${PB.name}`,
          source: {
            kind: "playbook",
            triggerType: "manual", // generic Start-trigger → notrigger/<uuid>
            uuid: PB.uuid,
            iri: "/api/3/workflows/" + PB.uuid,
            name: PB.name,
          },
          params: {},
          autoExecute: true,
          output: { mode: "raw" },
        },
      });
    });

    test.afterAll(async () => {
      if (vt) await vt.removeActionRendererWidget(MODULE).catch(() => {});
    });

    test(`fires "${PB.name}" via notrigger and renders its result`, async () => {
      const s = await launchSoarSession();
      try {
        // Capture the trigger request so we can prove the GENERIC endpoint fired
        // (manual notrigger), not the record-action endpoint.
        const triggerUrls = [];
        s.page.on("request", (r) => {
          const u = r.url();
          if (/\/api\/triggers\/1\//.test(u)) triggerUrls.push(u);
        });

        await openRecord(s.page, s.base, MODULE, ALERT_UUID, { settleMs: 12000 });
        const root = s.page.locator(".action-renderer-widget").first();
        await expect(root).toBeVisible({ timeout: 30000 });

        // The widget auto-executes on mount; a playbook run + completion poll is
        // slower than a connector call. Poll the controller scope until it leaves
        // the loading state (or the deadline passes).
        await s.page.waitForFunction(
          () => {
            const el = document.querySelector(".action-renderer-widget");
            if (!el || !window.angular) return false;
            const sc = window.angular.element(el).scope();
            return sc && sc.loading === false;
          },
          { timeout: 90000 }
        );

        // Prove the GENERIC trigger endpoint was used (notrigger/<uuid>), not the
        // action endpoint. (The request may be proxied through the app host.)
        const notrigger = triggerUrls.find((u) => u.includes("/notrigger/" + PB.uuid));
        const actionHit = triggerUrls.find((u) => /\/action\//.test(u));
        console.log(`[ar-pb-render] trigger urls = ${JSON.stringify(triggerUrls)}`);
        expect(notrigger, "the manual playbook must fire via /api/triggers/1/notrigger/<uuid>").toBeTruthy();
        expect(actionHit, "a generic playbook must NOT use the record-action endpoint").toBeFalsy();

        // The run completed and post-processing ran without a crash: no error
        // banner. When the playbook returns a non-null result, raw mode renders
        // it in <pre class="action-renderer-result-raw"> — assert that when present.
        const m = await s.page.evaluate(() => {
          const r = document.querySelector(".action-renderer-widget");
          const err = r.querySelector(".alert-danger");
          const pre = r.querySelector(".action-renderer-result-raw");
          const sc = window.angular.element(r).scope();
          return {
            error: err ? err.innerText.trim() : null,
            resultIsNull: !sc || sc.result === null || sc.result === undefined,
            rawText: pre ? pre.innerText.trim().slice(0, 200) : null,
          };
        });
        console.log(`[ar-pb-render] result = ${JSON.stringify(m)}`);
        expect(m.error, "the playbook run should not surface an error").toBeNull();
        if (!m.resultIsNull) {
          expect(m.rawText, "a non-null playbook result should render in the raw <pre>").toBeTruthy();
        }

        const errs = s.errors.meaningful();
        if (errs.length) console.log("[ar-pb-render] errors:\n" + errs.join("\n"));
        expect(errs, "no meaningful console/api errors during the playbook run").toEqual([]);
      } finally {
        await s.close();
      }
    });
  }
);
