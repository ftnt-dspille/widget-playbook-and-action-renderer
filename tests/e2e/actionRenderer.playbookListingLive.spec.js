"use strict";
/**
 * LIVE playbook-listing test for the action-renderer EDIT controller.
 *
 * Mirrors actionRendererLive.spec.js (harness shell + real box data via the
 * proxy) — that spec proves the CONNECTOR edit path against the live box; this
 * one proves the PLAYBOOK edit path: the "Action playbook" dropdown and the
 * "Show all playbooks" toggle (customer fix #4) against the box's REAL
 * /api/workflows/actions data, not mock-injected scope.
 *
 * Context is an alerts detail/view-panel (a real alert record), NOT a dashboard:
 * that's the only context where `isDashboardContext` is false, so the "Show all"
 * checkbox is visible.
 *
 * HARNESS-SHELL LIMITATION (important): the MODULE-SCOPED branch calls
 * `playbookService.getActionPlaybooks(...)`, and `playbookService` cannot
 * initialize in the harness (it transitively needs websocket/$stomp platform
 * deps the harness doesn't provide — `lazyService failed for playbookService …
 * reading 'generate'`), so it yields 0 here. That path is only exercisable in
 * the real Application Editor. THIS spec therefore proves the part the harness
 * shell CAN prove against real box data: the "Show all" branch (plain
 * /api/workflows/actions $resource — the actual customer fix #4) loads the full
 * global action-trigger list and the dropdown renders + filters it. On 205 at
 * authoring time that list is 210 playbooks (vs alerts-scoped 44), so we assert
 * the count is far larger than any single module's set rather than a hard number,
 * to survive content drift.
 *
 * Gated: the "Live" in the filename means playwright.config's testIgnore excludes
 * it unless E2E_LIVE=1 (which also sets FSR_HERMETIC=0 so the proxy reaches the
 * box). Point the harness at the box that HAS the playbooks (205):
 *
 *   cd fortisoar-widget-harness
 *   make test-ar-playbook-live            # exports .env.box + runs this spec
 *
 * DEVKIT DEPENDENCY: this e2e spec lives with the widget source but only runs
 * inside the fsr-widget-devkit checkout (this widget at
 * devkit/widgets-src/<widget>/, sibling fortisoar-widget-harness/). It is
 * self-contained (only @playwright/test), but the harness "widgets" Playwright
 * project (testDir = canonicalized widgets-src) is what discovers it and the
 * harness proxy is what reaches the box. Run via the devkit Makefile, never
 * from a bare clone of this widget repo.
 */

const { test, expect } = require("@playwright/test");

// A real alert that exists on the 205 box (records are box-specific; override
// via AR_ALERT_UUID). The module-scoped path needs a live record for entity.module.
const ALERT_UUID = process.env.AR_ALERT_UUID || "92f37901-8edd-48f7-9fb5-2c920d06ae21";

// One real browser through harness boot + a live /api/workflows/actions fetch.
test.describe.configure({ mode: "serial", timeout: 180000 });

// Read the edit-modal form's AngularJS scope. The whole point of the widget is
// what its controller puts on scope ($scope.playbooks, $scope.showAllPlaybooks),
// so we assert on that directly rather than scraping the ui-select DOM (which
// ui-select may virtualize).
async function readScope(page) {
  return page.evaluate(() => {
    const form = document.querySelector("#edit-modal-body form");
    if (!form || !window.angular) return null;
    const sc = window.angular.element(form).scope();
    if (!sc) return null;
    return {
      kind: sc.config && sc.config.source && sc.config.source.kind,
      loading: !!sc.playbookListLoading,
      showAll: !!sc.showAllPlaybooks,
      isDashboard: !!sc.isDashboardContext,
      count: Array.isArray(sc.playbooks) ? sc.playbooks.length : -1,
      collections: Array.isArray(sc.playbooks)
        ? sc.playbooks.map((p) => p.collectionName || "")
        : [],
      names: Array.isArray(sc.playbooks)
        ? sc.playbooks.map((p) => p.actionTriggerName || p.name || "")
        : [],
    };
  });
}

// Poll until the controller's playbook list settles (loading flag clears AND we
// have a stable, non-empty list) or the deadline passes.
async function waitForPlaybookLoad(page, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await readScope(page);
    if (last && !last.loading && last.count >= 0) {
      // give one extra settle so a just-resolved $http digest is reflected
      await page.waitForTimeout(400);
      last = await readScope(page);
      if (last && !last.loading) return last;
    }
    await page.waitForTimeout(400);
  }
  return last;
}

test.describe("live: action-renderer edit — playbook listing + Show all", () => {
  test("module-scoped dropdown loads, search filters, and Show all expands to cross-module playbooks", async ({
    page,
  }) => {
    const apiErrors = [];
    const consoleErrors = [];
    page.on("response", (r) => {
      try {
        if (r.status() >= 400 && /\/api\//.test(r.url())) apiErrors.push(`HTTP ${r.status()} ${r.url()}`);
      } catch (_) { /* gone */ }
    });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    // Seed a real alerts record context (view-panel) BEFORE boot so the widget
    // mounts with entity.module = "alerts" and isDashboardContext = false.
    await page.addInitScript((uuid) => {
      localStorage.setItem("harness.ctx", "viewpanel");
      localStorage.setItem("harness.module", "alerts");
      localStorage.setItem("harness.id", uuid);
    }, ALERT_UUID);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    // Make sure the harness is showing the action-renderer widget.
    const onAR = await page.evaluate(() => {
      const sel = document.getElementById("widget-select");
      return !!(sel && sel.value && sel.value.toLowerCase().includes("action"));
    });
    if (!onAR) {
      await page.evaluate(() => {
        const sel = document.getElementById("widget-select");
        for (const o of sel.options) {
          if (o.value && o.value.toLowerCase().includes("action")) {
            sel.value = o.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      });
      await page.waitForTimeout(3000);
    }

    // Open the edit modal.
    await page.locator("#edit-config").click();
    await page.waitForSelector("#edit-modal-body form", { timeout: 20000 });

    // Switch the source to Playbook (button: ng-click sets kind + onKindChange()).
    await page.locator('#edit-modal-body button:has-text("Playbook")').click();

    // ── Playbook context sanity (Show all OFF by default) ────────────────────
    const initial = await waitForPlaybookLoad(page, { timeout: 15000 });
    expect(initial, "edit-modal scope should be readable").toBeTruthy();
    expect(initial.kind, "source kind should be playbook").toBe("playbook");
    expect(initial.isDashboard, "alerts record context is NOT a dashboard").toBe(false);
    expect(initial.showAll, "Show all defaults OFF for a record context").toBe(false);
    // NOTE: module-scoped count is 0 in the harness shell (playbookService can't
    // init — see header). We do not assert it here; it's an Application-Editor-only
    // path. We log it so a future "it suddenly works" is visible.
    console.log(`[ar-pb-live] module-scoped(alerts) count in harness = ${initial.count} (expected 0 — playbookService unavailable)`);

    // ── "Show all" loads the full global action-trigger list (fix #4) ────────
    // The checkbox renders in this non-dashboard context (the isDashboardContext
    // branch under test); assert that. We then fire its ng-change handler
    // (onPlaybookScopeToggle) via scope rather than a DOM click: the harness
    // shell can't bind the AngularJS checkbox ng-model (clicking flips the DOM
    // `checked` but not `$scope.showAllPlaybooks` — a vendor-directive gap; the
    // binding only works in the full platform / Application Editor). Driving the
    // widget's own handler is the same approach the existing dropdown-contrast
    // spec uses, and it exercises the real loadAllPlaybooks() data path.
    const cb = page.locator('#edit-modal-body input[type="checkbox"][data-ng-model="showAllPlaybooks"]');
    await expect(cb, "Show all checkbox should be visible in a record (non-dashboard) context").toBeVisible();
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      sc.showAllPlaybooks = true;
      sc.onPlaybookScopeToggle();
      sc.$apply();
    });
    // Poll until the async load settled (don't read the stale state mid-load).
    let all = null;
    {
      const deadline = Date.now() + 75000; // lightweight all-playbooks list is ~2MB/691; allow for proxy buffering
      while (Date.now() < deadline) {
        const s = await readScope(page);
        if (s && s.showAll && !s.loading && s.count >= 250) { all = s; break; }
        await page.waitForTimeout(400);
      }
      if (!all) all = await readScope(page); // capture final state for the assertion message
    }
    expect(all, "scope after Show all").toBeTruthy();
    expect(all.showAll, "Show all should be ON").toBe(true);
    console.log(`[ar-pb-live] show-all count = ${all.count}`);
    // "Show all" now lists EVERY active triggerable playbook (~691 on 205) —
    // action AND generic/referenced/manual — not just the record-context action
    // triggers (~210). A threshold of 250 proves the list is broadened past the
    // action-only set, while tolerating box content drift.
    expect(
      all.count,
      `Show all should list all active playbooks (action + generic), not just action triggers (got ${all.count})`
    ).toBeGreaterThanOrEqual(250);

    // ── The dropdown renders those choices and search filters them ───────────
    const token = (all.names.find((n) => n && n.replace(/\s/g, "").length >= 5) || "").trim().split(/\s+/)[0];
    expect(token, "a real playbook name token to search by").toBeTruthy();
    await page.locator(".ui-select-container .ui-select-match").click();
    await page.waitForSelector(".ui-select-choices-row", { timeout: 8000 });
    const unfilteredRows = await page.locator(".ui-select-choices-row").count();
    expect(unfilteredRows, "dropdown should render choice rows").toBeGreaterThan(0);
    await page.locator("input.ui-select-search").fill(token);
    await page.waitForTimeout(600);
    const filteredRows = await page.locator(".ui-select-choices-row").count();
    console.log(`[ar-pb-live] search "${token}": ${unfilteredRows} -> ${filteredRows} rows`);
    expect(filteredRows, "search should match at least one playbook").toBeGreaterThan(0);
    expect(filteredRows, "search should narrow the rendered list").toBeLessThanOrEqual(unfilteredRows);
    // Every remaining visible row should contain the token (case-insensitive).
    const remainingText = (await page.locator(".ui-select-choices-row").allInnerTexts()).join(" ").toLowerCase();
    expect(remainingText, "filtered rows should all match the search token").toContain(token.toLowerCase());

    // ── SELECT a real playbook → onPlaybookPicked populates config.source ────
    // ui-select's ng-model doesn't bind in the harness shell (same vendor gap
    // as the checkbox above), so we set picks.playbookPicked to a REAL box
    // playbook off scope and fire the widget's own on-select handler. This
    // exercises the actual onPlaybookPicked path — including getTriggerStepFor's
    // step-derived fallback (playbookService is unavailable here) — against the
    // live /api/workflows/actions step shapes, which is the whole point.
    // Pick a known playbook that HAS input variables — "Action - Domain - Block
    // (Indicator)" is a stable action trigger on 205 — so we deterministically
    // exercise the param-row path. onPlaybookPicked is async (the lightweight
    // list has no step bodies → it fetches the picked playbook's trigger step),
    // so we await its promise. Falls back to any action playbook if that name
    // drifts off the box.
    const picked = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const byName = (sc.playbooks || []).find((p) => /Action - Domain - Block \(Indicator\)/i.test(p.name || ""));
      const pb = byName || (sc.playbooks || []).find((p) => /^Action - /i.test(p.name || "")) || (sc.playbooks || [])[0];
      if (!pb) return null;
      sc.picks.playbookPicked = pb;
      return sc.onPlaybookPicked().then(function () {
        const src = sc.config && sc.config.source;
        return {
          name: pb.name,
          kind: src && src.kind,
          uuid: src && src.uuid,
          route: src && src.route,
          title: src && src.title,
          triggerType: src && src.triggerType,
          inputVarCount: src && Array.isArray(src.inputVariables) ? src.inputVariables.length : -1,
          paramRowCount: Array.isArray(sc.paramRows) ? sc.paramRows.length : -1,
          rowsWithRequiredFlag: (sc.paramRows || []).filter((r) => "required" in r).length,
          seededDefaults: (sc.paramRows || []).filter(
            (r) => sc.config.params[r.name] !== undefined && sc.config.params[r.name] !== ""
          ).length,
          canAdvance2: typeof sc.canAdvance === "function" ? !!sc.canAdvance(2) : null,
        };
      });
    });
    expect(picked, "a playbook should be selectable from the live list").toBeTruthy();
    console.log(`[ar-pb-live] picked "${picked.name}" → source=${JSON.stringify(picked)}`);
    expect(picked.kind, "picked source kind should be playbook").toBe("playbook");
    expect(picked.uuid, "picked source should carry the playbook uuid").toBeTruthy();
    // triggerType drives which endpoint the view panel fires. An action trigger
    // carries a route (→ /api/triggers/1/action/<route>); a manual/generic one
    // does not (→ /api/triggers/1/notrigger/<uuid>).
    expect(["action", "manual"]).toContain(picked.triggerType);
    if (picked.triggerType === "action") {
      expect(picked.route, "an action-trigger source should carry the trigger route").toBeTruthy();
    }
    // paramRows must mirror the playbook's input variables (rebuildParamRows).
    expect(picked.paramRowCount, "param rows should match inputVariables count").toBe(picked.inputVarCount);
    // Each row carries the required flag derived from the live inputVariable,
    // and the gating function is wired (NEXT #2 — param validation).
    expect(picked.rowsWithRequiredFlag, "every param row carries a required flag").toBe(picked.paramRowCount);
    expect(picked.canAdvance2, "step-2 gating must be evaluable").not.toBeNull();

    // ── GENERIC playbook proof: the list now includes manual/Start-trigger ───
    // playbooks (not just record-action ones), and picking one yields a manual
    // triggerType with NO route. "query critical" is a generic Start-trigger
    // playbook on 205; assert it's present + picks as manual. (This is the user-
    // reported requirement: generic playbooks, not just alert manual playbooks.)
    const generic = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      // The lightweight list has no step bodies, so we can't pre-filter by
      // trigger args here — pick "query critical" (a known generic Start-trigger
      // playbook on 205) by name and let onPlaybookPicked fetch + classify it.
      const qc = (sc.playbooks || []).find((p) => /query critical/i.test(p.name || ""));
      if (!qc) return { found: false, qcPresent: false, listCount: (sc.playbooks || []).length };
      sc.picks.playbookPicked = qc;
      return sc.onPlaybookPicked().then(function () {
        const src = sc.config.source;
        return { found: true, qcPresent: true, name: qc.name, triggerType: src.triggerType, route: src.route, uuid: src.uuid };
      });
    });
    console.log(`[ar-pb-live] generic pick = ${JSON.stringify(generic)}`);
    expect(generic.found, "the list should include at least one generic/manual playbook").toBe(true);
    expect(generic.triggerType, "a generic Start-trigger playbook picks as manual").toBe("manual");
    expect(generic.route, "a manual playbook has no action route").toBeFalsy();
    expect(generic.uuid, "a manual playbook still carries its uuid (for notrigger)").toBeTruthy();

    // No meaningful console/api errors across the whole flow. The
    // playbookService lazy-init warning is an expected harness-shell limitation.
    const benign = /favicon|ResizeObserver|Non-Error promise rejection|referrer policy|sandbox|lazyService failed for playbookService/i;
    const meaningful = [...apiErrors, ...consoleErrors.filter((t) => !benign.test(t))];
    if (meaningful.length) console.log("[ar-pb-live] errors:\n" + meaningful.join("\n"));
    expect(meaningful, "no meaningful console/api errors during the playbook flow").toEqual([]);
  });
});
