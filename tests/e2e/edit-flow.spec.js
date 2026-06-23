"use strict";
// E2E tests for the action-renderer widget's Edit modal, exercised through
// the dev harness against a live SOAR test host. Verifies the four-step
// wizard, both source kinds (connector + playbook), and the save/reopen
// round-trip.
//
// Picked up by harness/playwright.config.js via the widgets-src/*/tests/e2e/
// glob, so `cd fortisoar-widget-harness && npx playwright test` runs them
// alongside the harness's own specs.
//
// Requires a real SOAR test host (FORTISOAR_HOST/USERNAME/PASSWORD in .env)
// and a known alert UUID. The default UUID below points at the alert the
// project uses for action-renderer development; override with
// AR_ALERT_UUID=<uuid> if running against a different SOAR.
//
// Network calls go through the harness proxy (/api/3/* and /api/wf/*).

const { test, expect } = require("../../../../fortisoar-widget-harness/tests/e2e/_fixtures");

const ALERT_UUID =
  process.env.AR_ALERT_UUID || "db7afbf7-56c8-4706-87b9-9a8ce2332d05";
const CONNECTOR_NAME_PATTERN = /hello[- ]world/i; // Must exist on the SOAR test host.

// Seed harness localStorage so the boot picks the action-renderer widget on
// an Alert record under the View Panel context. Done before reload so the
// initial mountWidget() call already targets the right state.
async function seedHarness(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((uuid) => {
    localStorage.setItem("harness.module", "alerts");
    localStorage.setItem("harness.id", uuid);
    localStorage.setItem("harness.ctx", "viewpanel");
    // Force the widget select to action-renderer at next mount.
    const cur = JSON.parse(localStorage.getItem("harness.currentWidget") || "null");
    if (!cur || cur.id !== "actionRendererWidget-1.0.6") {
      localStorage.setItem("harness.currentWidget", JSON.stringify({ id: "actionRendererWidget-1.0.6" }));
    }
    // Wipe any saved widget config so each test starts from a clean slate.
    localStorage.removeItem("harness.widgetConfig.actionRendererWidget-1.0.6");
  }, ALERT_UUID);
  await page.reload({ waitUntil: "domcontentloaded" });
  // The harness fetches the record before mounting the widget; wait for it.
  await page.waitForFunction(() => !!window.__HARNESS_RECORD, { timeout: 20000 });
  await page.waitForTimeout(2500);
  // If the dropdown isn't already on the action-renderer (first boot may
  // default to c3Charts), switch it now and let the harness re-mount.
  const onActionRenderer = await page.evaluate(() => {
    const sel = document.getElementById("widget-select");
    return sel.value && sel.value.toLowerCase().includes("action");
  });
  if (!onActionRenderer) {
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
    await page.waitForTimeout(5000);
  }
}

async function openEditModal(page) {
  await page.click("#edit-config");
  // The connector picker is now a searchable ui-select; wait for the container
  // to render and for the connector list to load (scope.connectors populated).
  await page.waitForSelector(
    "#edit-modal-body ui-select[data-ng-model='picks.connectorPicked']",
    { timeout: 30000 }
  );
  await page.waitForFunction(
    () => {
      const form = document.querySelector("#edit-modal-body form");
      const s = form && window.angular.element(form).scope();
      return s && (s.connectors || []).length > 0;
    },
    { timeout: 20000 }
  );
}

// The connector ui-select can't be driven via native <option> elements, so
// select through the controller scope (the same path data-on-select triggers).
// predicateSource picks the first connector whose label matches; null picks the
// first one.
function pickConnectorViaScope(page, predicateSource) {
  return page.evaluate(
    (predicateSource) => {
      const form = document.querySelector("#edit-modal-body form");
      const s = form && window.angular.element(form).scope();
      if (!s || !(s.connectors || []).length) return { ok: false };
      let pick = s.connectors[0];
      if (predicateSource) {
        const re = new RegExp(predicateSource, "i");
        pick = s.connectors.find((c) => re.test(c.label || "")) || pick;
      }
      s.picks.connectorPicked = pick;
      s.onConnectorPicked();
      s.$apply();
      return { ok: true, picked: pick.label };
    },
    predicateSource
  );
}

function readScope(page) {
  return page.evaluate(() => {
    const form = document.querySelector("#edit-modal-body form");
    if (!form) return null;
    const s = window.angular.element(form).scope();
    const body = document.querySelector("#edit-modal-body");
    return {
      activeStep: s.activeStep,
      canAdvance: s.canAdvance(s.activeStep),
      configSource: {
        kind: s.config.source.kind,
        name: s.config.source.name,
        version: s.config.source.version,
        operation: s.config.source.operation,
        config: s.config.source.config,
        configRequired: s.config.source.configRequired,
        uuid: s.config.source.uuid,
        iri: s.config.source.iri,
        inputVariables: (s.config.source.inputVariables || []).map((v) => v.name),
      },
      params: s.config.params,
      paramRowsLen: (s.paramRows || []).length,
      paramRowNames: (s.paramRows || []).map((r) => r.name),
      paramTextareaCount: body.querySelectorAll(
        ".form-group[data-ng-repeat] textarea"
      ).length,
      visibleAlerts: Array.from(body.querySelectorAll(".alert")).map((a) =>
        a.innerText.trim().slice(0, 200)
      ),
      stepperVisible: !!body.querySelector(".action-renderer-stepper"),
      navVisible: !!body.querySelector(".action-renderer-nav"),
    };
  });
}

function clickInBody(page, regexSource) {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    for (const b of document.querySelectorAll("#edit-modal-body button"))
      if (re.test(b.innerText.trim())) {
        b.click();
        return true;
      }
    return false;
  }, regexSource);
}

function pickSelect(page, ngModel, predicateSource) {
  return page.evaluate(
    ({ ngModel, predicateSource }) => {
      const sel = document.querySelector(
        `#edit-modal-body select[data-ng-model='${ngModel}']`
      );
      if (!sel || sel.options.length < 2) return { ok: false };
      let idx = 1;
      if (predicateSource) {
        const re = new RegExp(predicateSource, "i");
        for (let i = 1; i < sel.options.length; i++) {
          if (re.test(sel.options[i].text)) { idx = i; break; }
        }
      }
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, picked: sel.options[idx].text };
    },
    { ngModel, predicateSource }
  );
}

function pickSelectExcluding(page, ngModel, regexSource) {
  return page.evaluate(
    ({ ngModel, regexSource }) => {
      const sel = document.querySelector(
        `#edit-modal-body select[data-ng-model='${ngModel}']`
      );
      if (!sel || sel.options.length < 2) return { ok: false };
      const re = new RegExp(regexSource, "i");
      let idx = 1;
      for (let i = 1; i < sel.options.length; i++) {
        if (!re.test(sel.options[i].text)) { idx = i; break; }
      }
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, picked: sel.options[idx].text };
    },
    { ngModel, regexSource }
  );
}

// Programmatically type into a textarea so AngularJS ngModel picks it up.
function typeIntoTextarea(page, selector, value) {
  return page.evaluate(
    ({ selector, value }) => {
      const ta = document.querySelector(selector);
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ta, value);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    { selector, value }
  );
}

// ---------------------------------------------------------------------------

test.describe("action-renderer edit modal", () => {
  // Capture page errors per test. AngularJS lex/parse errors are reported
  // via console.error; the modal can still appear functional, so we assert
  // there were none.
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

  test("stepper, Back/Next, and step navigation render in the modal body", async ({ page }) => {
    const sc = await readScope(page);
    expect(sc.stepperVisible, "stepper survives SOAR's modal-header strip").toBe(true);
    expect(sc.navVisible, "Back/Next survive SOAR's modal-footer strip").toBe(true);
    expect(sc.activeStep).toBe(1);
  });

  test("connector flow: pick → params → run → output → save", async ({ page }) => {
    const conn = await pickConnectorViaScope(page, CONNECTOR_NAME_PATTERN.source);
    expect(conn.ok, "connector picked").toBe(true);
    await page.waitForTimeout(2500);

    const op = await pickSelectExcluding(page, "picks.operationPicked", "deprecated");
    expect(op.ok, "operation picked").toBe(true);
    await page.waitForTimeout(500);

    const cfg = await pickSelect(page, "picks.configPicked", null);
    expect(cfg.ok, "config picked").toBe(true);
    await page.waitForTimeout(500);

    let sc = await readScope(page);
    expect(sc.configSource.name).toBeTruthy();
    expect(sc.configSource.operation).toBeTruthy();
    expect(sc.configSource.config || sc.configSource.configRequired === false).toBeTruthy();
    expect(sc.canAdvance, "Next enabled when source step complete").toBe(true);

    await clickInBody(page, "^Next");
    await page.waitForTimeout(400);
    sc = await readScope(page);
    expect(sc.activeStep).toBe(2);
    expect(sc.paramTextareaCount, "param textareas match paramRows").toBe(sc.paramRowsLen);

    if (sc.paramTextareaCount > 0) {
      await typeIntoTextarea(
        page,
        "#edit-modal-body .form-group[data-ng-repeat] textarea",
        "PROBE_VALUE"
      );
      await page.waitForTimeout(200);
      const after = await readScope(page);
      expect(Object.values(after.params)).toContain("PROBE_VALUE");
    }

    await clickInBody(page, "^Next");
    await page.waitForTimeout(300);
    sc = await readScope(page);
    expect(sc.activeStep).toBe(3);
    const hasRunBtn = await page.evaluate(() =>
      !!Array.from(document.querySelectorAll("#edit-modal-body button"))
        .find((b) => /Run with current record/i.test(b.innerText))
    );
    expect(hasRunBtn, "step 3 shows the Run button").toBe(true);

    await clickInBody(page, "^Next");
    await page.waitForTimeout(300);
    sc = await readScope(page);
    expect(sc.activeStep).toBe(4);

    // Output mode tabs all render their respective inputs.
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#edit-modal-body .nav-pills a")).map((a) =>
        a.innerText.trim()
      )
    );
    expect(tabs.join(" ")).toMatch(/Raw JSON/);
    expect(tabs.join(" ")).toMatch(/Table/);
    expect(tabs.join(" ")).toMatch(/Jinja/);

    await page.evaluate(() => {
      for (const a of document.querySelectorAll("#edit-modal-body .nav-pills a"))
        if (/Table/i.test(a.innerText)) { a.click(); return; }
    });
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() =>
        !!document.querySelector("#edit-modal-body input[data-ng-model='config.output.table.rootPath']")
      ),
      "Table mode renders the rootPath input"
    ).toBe(true);

    await page.evaluate(() => {
      for (const a of document.querySelectorAll("#edit-modal-body .nav-pills a"))
        if (/Jinja/i.test(a.innerText)) { a.click(); return; }
    });
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(() =>
        !!document.querySelector("#edit-modal-body .action-renderer-jinja-pane")
      ),
      "Jinja mode renders the inline editor pane"
    ).toBe(true);
  });

  test("playbook flow: list loads, picking populates inputVariables and renders textareas", async ({ page }) => {
    // Switch source kind to playbook.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("#edit-modal-body .btn-group .btn"))
        if (/^Playbook$/i.test(b.innerText.trim())) { b.click(); return; }
    });
    // Playbook list fetch is async; wait for it.
    await page.waitForFunction(
      () => {
        const s = document.querySelector(
          "#edit-modal-body select[data-ng-model='picks.playbookPicked']"
        );
        return s && s.options.length > 1;
      },
      { timeout: 25000 }
    );

    const total = await page.evaluate(() => {
      const x = document.querySelector(
        "#edit-modal-body select[data-ng-model='picks.playbookPicked']"
      );
      return x.options.length - 1;
    });
    expect(total, `at least one action-trigger playbook for module 'alerts'`).toBeGreaterThan(0);

    // Walk options to find one with input variables (so we exercise the
    // params path); cap at 12 to keep the test fast.
    let chosen = null;
    for (let i = 1; i <= Math.min(total, 12); i++) {
      await page.evaluate((idx) => {
        const x = document.querySelector(
          "#edit-modal-body select[data-ng-model='picks.playbookPicked']"
        );
        x.selectedIndex = idx;
        x.dispatchEvent(new Event("change", { bubbles: true }));
      }, i);
      await page.waitForTimeout(300);
      const probe = await readScope(page);
      if (probe.configSource.inputVariables.length > 0) {
        chosen = { idx: i, ivCount: probe.configSource.inputVariables.length };
        break;
      }
    }
    test.info().annotations.push({
      type: "info",
      description: chosen
        ? `picked playbook idx ${chosen.idx} with ${chosen.ivCount} input vars`
        : "no playbook with input vars in first 12 — falling back to first option",
    });

    let sc = await readScope(page);
    expect(sc.configSource.kind).toBe("playbook");
    expect(sc.configSource.uuid, "config.source.uuid set after pick").toBeTruthy();
    expect(sc.configSource.iri, "config.source.iri set after pick").toBeTruthy();
    expect(sc.canAdvance, "Next enabled after playbook pick").toBe(true);

    await clickInBody(page, "^Next");
    await page.waitForTimeout(400);
    sc = await readScope(page);
    expect(sc.activeStep).toBe(2);
    expect(sc.paramRowsLen).toBe(sc.configSource.inputVariables.length);
    expect(sc.paramTextareaCount).toBe(sc.paramRowsLen);

    if (sc.paramRowsLen > 0) {
      await typeIntoTextarea(
        page,
        "#edit-modal-body .form-group[data-ng-repeat] textarea",
        "PB_PROBE"
      );
      await page.waitForTimeout(200);
      const after = await readScope(page);
      expect(Object.values(after.params)).toContain("PB_PROBE");
    } else {
      expect(sc.visibleAlerts.some((a) => /takes no input parameters/i.test(a))).toBe(true);
    }

    // Walk to step 3 and 4 to confirm playbook flow doesn't break navigation.
    await clickInBody(page, "^Next");
    await page.waitForTimeout(300);
    expect((await readScope(page)).activeStep).toBe(3);
    await clickInBody(page, "^Next");
    await page.waitForTimeout(300);
    expect((await readScope(page)).activeStep).toBe(4);
  });

  test("saved connector config is restored on reopen", async ({ page }) => {
    // Configure step 1 fully.
    await pickConnectorViaScope(page, CONNECTOR_NAME_PATTERN.source);
    await page.waitForTimeout(2500);
    await pickSelectExcluding(page, "picks.operationPicked", "deprecated");
    await page.waitForTimeout(500);
    await pickSelect(page, "picks.configPicked", null);
    await page.waitForTimeout(500);

    const before = await page.evaluate(() => {
      const f = document.querySelector("#edit-modal-body form");
      const s = window.angular.element(f).scope();
      return {
        name: s.config.source.name,
        version: s.config.source.version,
        operation: s.config.source.operation,
        config: s.config.source.config,
      };
    });

    // Click harness Save and wait for re-mount to settle.
    await page.click("#edit-modal-save");
    await page.waitForFunction(
      () => !document.getElementById("edit-modal-backdrop").classList.contains("open"),
      { timeout: 10000 }
    );
    // Harness re-mounts the widget after save; give it generous time on
    // viewpanel ctx (record refetch + injector recreate).
    await page.waitForTimeout(7000);

    // Reopen and verify saved values are present in the new injector's scope.
    await openEditModal(page);
    await page.waitForTimeout(2500);

    const after = await page.evaluate(() => {
      const f = document.querySelector("#edit-modal-body form");
      const s = window.angular.element(f).scope();
      return {
        name: s.config.source.name,
        version: s.config.source.version,
        operation: s.config.source.operation,
        config: s.config.source.config,
        paramRowsLen: (s.connectorParamFields || []).length,
      };
    });
    expect(after.name).toBe(before.name);
    expect(after.version).toBe(before.version);
    expect(after.operation).toBe(before.operation);
    expect(after.config).toBe(before.config);
    expect(
      after.paramRowsLen,
      "paramRows re-derived from live connector on reopen"
    ).toBeGreaterThan(0);
  });

  // Regression: connector params are rendered through SOAR's
  // cs-connector-field-renderer / cs-field. Two bugs we've hit:
  //   (a) `placeholder="{{ ::placeholder }}"` from input.html leaking into the
  //       DOM unevaluated when the harness fetches the template at runtime
  //       (real SOAR ships it pre-compiled into $templateCache).
  //   (b) text inputs rendering as ~5px-tall slivers when the cs-field
  //       template lands without the form-control sizing rules.
  // Pick FortiGate's "Get Blocked IP Addresses" because it has a select with
  // an onchange that reveals text + select children, exercising both
  // top-level and nested rendering.
  test("connector params: no literal Angular interpolation, inputs are usable size", async ({ page }) => {
    // Pick FortiGate explicitly via scope so we don't depend on harness's
    // Hello World here.
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const fgt = (sc.connectors || []).find((c) => /fortigate-firewall/i.test(c.name));
      if (!fgt) throw new Error("FortiGate connector not installed on test SOAR");
      sc.picks.connectorPicked = fgt;
      sc.onConnectorPicked();
      sc.$apply();
    });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const op = (sc.connectorDetails.operations || []).find((o) =>
        /get blocked ip/i.test(o.title)
      );
      sc.picks.operationPicked = op;
      sc.onOperationPicked();
      const cfgs = sc.connectorDetails.configuration || [];
      if (cfgs.length) { sc.picks.configPicked = cfgs[0].config_id; sc.onConfigPicked(); }
      sc.gotoStep(2);
      sc.$apply();
    });
    await page.waitForTimeout(2500);

    // Reveal the onchange children too.
    await page.evaluate(() => {
      for (const sel of document.querySelectorAll("#edit-modal-body select")) {
        for (const o of sel.options) {
          if (/policy based/i.test(o.text)) {
            sel.value = o.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      }
    });
    await page.waitForTimeout(1500);

    const audit = await page.evaluate(() => {
      const containers = document.querySelectorAll("#edit-modal-body .action-renderer-cs-fields");
      const root = containers[0] || document.querySelector("#edit-modal-body");
      const fields = Array.from(root.querySelectorAll("input.form-control, select.form-control, textarea.form-control"));
      const leaks = [];
      const sizeIssues = [];
      for (const f of fields) {
        const ph = f.getAttribute("placeholder") || "";
        const val = f.value || "";
        const cls = f.className || "";
        if (/\{\{|\}\}/.test(ph) || /\{\{|\}\}/.test(val) || /\{\{|\}\}/.test(cls)) {
          leaks.push({ tag: f.tagName, name: f.name, ph, val: val.slice(0, 80), cls: cls.slice(0, 80) });
        }
        const rect = f.getBoundingClientRect();
        if (rect.height < 20 && rect.width > 20) {
          sizeIssues.push({ tag: f.tagName, name: f.name, h: rect.height, w: rect.width });
        }
      }
      // Also scan the whole modal body for any text node that contains the
      // raw "{{ ::placeholder }}" string — covers cases where it ends up in
      // an attribute value the querySelector loop missed.
      const literalInDom = (root.innerHTML.match(/\{\{\s*::?placeholder\s*\}\}/g) || []).length;
      // cs-field renders a read-only `.jinja-tag-view-container` div when
      // field.jinjaExpressionView is false. For text-style fields we want the
      // actual <input>; an empty tag-view container for a text field is the
      // "thin grey bar" UX bug.
      const tagViewBars = [];
      const csFields = Array.from(root.querySelectorAll("[data-cs-field]"));
      for (const csf of csFields) {
        const tagView = csf.querySelector(".jinja-tag-view-container");
        if (!tagView) continue;
        // a select/picklist legitimately renders without an input; only flag
        // when there's no usable input/select/textarea inside the row at all.
        const usable = csf.querySelector("input.form-control, select.form-control, textarea.form-control");
        if (!usable) {
          const rect = tagView.getBoundingClientRect();
          tagViewBars.push({ html: csf.outerHTML.slice(0, 140), h: rect.height });
        }
      }
      return { leaks, sizeIssues, fieldCount: fields.length, literalInDom, tagViewBars };
    });
    expect(audit.fieldCount, "at least one cs-field input/select rendered").toBeGreaterThan(0);
    expect(audit.literalInDom, "no '{{ ::placeholder }}' literal in modal HTML").toBe(0);
    expect(audit.leaks, "no input/select has unevaluated {{...}} in placeholder/value/class").toEqual([]);
    expect(audit.sizeIssues, "no input/select rendered with height < 20px").toEqual([]);
    expect(audit.tagViewBars, "no text field stuck in read-only jinja-tag-view (empty thin bar)").toEqual([]);
  });

  // Regression: typing into a connector param input must propagate up through
  // cs-field → cs-connector-field-renderer.onChange into config.params, so
  // closing the modal preserves the value. Was broken when our harness clean
  // input.html template dropped ng-change="changeMethod(value, field)".
  // We don't go through the DOM input event (cs-field's ng-model wiring is
  // exercised by other paths); instead simulate the renderer onChange call
  // that fires from the input's ng-change and assert config.params updates.
  test("connector params: changeMethod propagates value into config.params", async ({ page }) => {
    // Pinned to Hello World — confirmed to expose at least one operation with
    // a text-style param. Don't fall back to "first connector" (some test
    // hosts list noisy ones first), and don't silently skip.
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const c = (sc.connectors || []).find((x) => /hello[- ]world/i.test(x.name));
      if (!c) throw new Error("Hello World connector not installed on test SOAR");
      sc.picks.connectorPicked = c; sc.onConnectorPicked(); sc.$apply();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const TEXT_LIKE = ["text","integer","number","json","array","password"];
      const op = (sc.connectorDetails.operations || [])
        .find((o) => (o.parameters || []).some((p) => TEXT_LIKE.indexOf(p.type) >= 0));
      if (!op) throw new Error("no hello-world op has a text-style param");
      sc.picks.operationPicked = op; sc.onOperationPicked();
      const cfgs = sc.connectorDetails.configuration || [];
      if (cfgs.length) { sc.picks.configPicked = cfgs[0].config_id; sc.onConfigPicked(); }
      sc.gotoStep(2); sc.$apply();
    });
    // The renderer is gated by ng-if on connectorParamFields.length, so it
    // mounts on the next digest. Wait for the directive to actually be in
    // DOM before grabbing its isolate scope.
    await page.waitForFunction(() => {
      return !!document.querySelector(
        "#edit-modal-body .action-renderer-cs-fields cs-connector-field-renderer.ng-isolate-scope"
      );
    }, { timeout: 5000 });
    await page.waitForTimeout(400);
    const result = await page.evaluate(() => {
      const TEXT_LIKE = ["text","integer","number","json","array","password"];
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const renderer = document.querySelector(
        "#edit-modal-body .action-renderer-cs-fields cs-connector-field-renderer.ng-isolate-scope"
      );
      const rsc = window.angular.element(renderer).isolateScope() ||
                  window.angular.element(renderer).scope();
      const target = (rsc.jsonData || []).find((p) => TEXT_LIKE.indexOf(p.type) >= 0);
      if (!target) return { fail: "no text param in renderer.jsonData",
        rscKeys: Object.keys(rsc || {}).filter(k => !k.startsWith("$")),
        rendererJsonData: (rsc.jsonData || []).map(p => ({ n: p.name, t: p.type })),
        scParamFields: (sc.connectorParamFields || []).map(p => ({ n: p.name, t: p.type })),
      };
      rsc.onChange("PROBE_PARAM_VALUE", target);
      rsc.$apply();
      return {
        targetName: target.name,
        targetType: target.type,
        params: angular.copy(sc.config.params),
        fieldValue: target.value,
      };
    });
    expect(result.fail, JSON.stringify(result)).toBeFalsy();
    expect(result.fieldValue, "field.value updated by changeMethod").toBe("PROBE_PARAM_VALUE");
    expect(
      result.params[result.targetName],
      "config.params[name] updated by renderer onChange wiring"
    ).toBe("PROBE_PARAM_VALUE");
  });

  // Regression: Next on step 2 must be disabled until all required params
  // have a value. Previously canAdvance(2) returned true unconditionally,
  // letting users advance with empty required fields.
  test("connector params: Next is disabled until required params filled", async ({ page }) => {
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const fgt = (sc.connectors || []).find((c) => /fortigate-firewall/i.test(c.name));
      if (!fgt) throw new Error("FortiGate connector not installed on test SOAR");
      sc.picks.connectorPicked = fgt; sc.onConnectorPicked(); sc.$apply();
    });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const op = (sc.connectorDetails.operations || []).find((o) =>
        /get blocked ip/i.test(o.title));
      sc.picks.operationPicked = op; sc.onOperationPicked();
      const cfgs = sc.connectorDetails.configuration || [];
      if (cfgs.length) { sc.picks.configPicked = cfgs[0].config_id; sc.onConfigPicked(); }
      sc.gotoStep(2); sc.$apply();
    });
    await page.waitForTimeout(2000);

    // Wipe all param values to guarantee at least one required field is empty.
    const blank = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      function walk(arr) {
        (arr || []).forEach((p) => {
          if (p) p.value = "";
          if (p && Array.isArray(p.parameters)) walk(p.parameters);
        });
      }
      walk(sc.connectorParamFields);
      sc.config.params = {};
      sc.$apply();
      const hasRequired = (function check(arr) {
        return (arr || []).some((p) =>
          (p.required && p.editable !== false && p.visible !== false) ||
          (Array.isArray(p.parameters) && check(p.parameters))
        );
      })(sc.connectorParamFields);
      return { hasRequired, canAdvance: sc.canAdvance(2) };
    });
    if (!blank.hasRequired) test.skip(true, "operation has no required params; nothing to gate on");
    expect(blank.canAdvance, "Next disabled when required params empty").toBe(false);

    const nextDisabled = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("#edit-modal-body button"))
        .find((b) => /^\s*Next/.test(b.innerText));
      return btn ? btn.disabled : null;
    });
    expect(nextDisabled, "Next button reflects canAdvance via ng-disabled").toBe(true);

    // Fill every required field with a placeholder Jinja-ish value and
    // confirm canAdvance flips true.
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      function walk(arr) {
        (arr || []).forEach((p) => {
          if (p && p.required && p.editable !== false && p.visible !== false) {
            p.value = "X";
            sc.config.params[p.name] = "X";
          }
          if (p && Array.isArray(p.parameters)) walk(p.parameters);
        });
      }
      walk(sc.connectorParamFields);
      sc.$apply();
    });
    const filled = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      return sc.canAdvance(2);
    });
    expect(filled, "Next enabled once required params filled").toBe(true);
  });

  // Regression: Save must refuse to close the modal until the user has
  // walked through all four steps. Previously save() closed unconditionally
  // even when required params were empty or Output was never visited.
  test("save: refuses to close until all steps are complete", async ({ page }) => {
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const c = (sc.connectors || []).find((x) => /hello[- ]world/i.test(x.name)) || sc.connectors[0];
      sc.picks.connectorPicked = c; sc.onConnectorPicked(); sc.$apply();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const op = (sc.connectorDetails.operations || []).find((o) => !/deprecated/i.test(o.title));
      sc.picks.operationPicked = op; sc.onOperationPicked();
      const cfgs = sc.connectorDetails.configuration || [];
      if (cfgs.length) { sc.picks.configPicked = cfgs[0].config_id; sc.onConfigPicked(); }
      sc.$apply();
    });

    // Step 1 done, but never advanced to 2/3/4. Save must NOT close.
    const earlySave = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      const open = !!document.querySelector("#edit-modal-body");
      const can = sc.canSave();
      sc.save();
      sc.$apply();
      const stillOpen = !!document.querySelector("#edit-modal-body");
      return { open, can, stillOpen, activeStep: sc.activeStep };
    });
    expect(earlySave.open, "modal open before save").toBe(true);
    expect(earlySave.can, "canSave is false before reaching step 4").toBe(false);
    expect(earlySave.stillOpen, "save() did not close modal early").toBe(true);

    // Walk through to step 4, then save should succeed (canSave=true).
    const lateSave = await page.evaluate(() => {
      const sc = window.angular.element(document.querySelector("#edit-modal-body form")).scope();
      sc.gotoStep(2); sc.gotoStep(3); sc.gotoStep(4); sc.$apply();
      return sc.canSave();
    });
    expect(lateSave, "canSave true after visiting step 4").toBe(true);
  });
});
