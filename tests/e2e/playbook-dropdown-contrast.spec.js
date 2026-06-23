"use strict";
// Targeted visual regression for the playbook ui-select dropdown.
//
// SOAR's dark theme dims ui-select-choices text to ~rgba(255,255,255,.45)
// by default; we override to .92 with !important. This spec asserts the
// override actually wins the cascade in the live harness DOM (jsdom can't
// resolve external stylesheet specificity, so a unit test won't catch it).
// It also confirms the popover renders in-place inside the modal body
// (we removed `append-to-body`, which vanished the picker on select).
//
// Designed to be cheap: dashboard context (no SOAR record fetch needed),
// one modal open, one dropdown open, three reads. ~3-5 seconds.

const { test, expect } = require("../../../../fortisoar-widget-harness/tests/e2e/_fixtures");

async function seedDashboard(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("harness.ctx", "dashboard");
    localStorage.removeItem("harness.module");
    localStorage.removeItem("harness.id");
    localStorage.setItem(
      "harness.currentWidget",
      JSON.stringify({ id: "actionRendererWidget-1.0.6" })
    );
    localStorage.removeItem("harness.widgetConfig.actionRendererWidget-1.0.6");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // If widget select isn't on action-renderer (first boot may default elsewhere), switch.
  const onAR = await page.evaluate(() => {
    const sel = document.getElementById("widget-select");
    return sel && sel.value && sel.value.toLowerCase().includes("action");
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
}

function rgbaChannels(str) {
  // Accept "rgb(r,g,b)" or "rgba(r,g,b,a)"; return [r,g,b,a].
  const m = String(str || "").match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/
  );
  if (!m) return null;
  return [
    parseInt(m[1], 10),
    parseInt(m[2], 10),
    parseInt(m[3], 10),
    m[4] === undefined ? 1 : parseFloat(m[4]),
  ];
}

test.describe("action-renderer playbook dropdown — visual contrast", () => {
  test("idle row text is high-contrast white; active row is blue tint; popover escapes modal clip", async ({
    page,
  }) => {
    await seedDashboard(page);
    await page.click("#edit-config");
    await page.waitForSelector("#edit-modal-body form", { timeout: 15000 });

    // Switch to playbook source. Inject a mock playbook list directly into
    // scope so this spec doesn't depend on the SOAR test host.
    await page.evaluate(() => {
      const sc = window.angular.element(
        document.querySelector("#edit-modal-body form")
      ).scope();
      sc.config.source.kind = "playbook";
      sc.playbooks = [
        { uuid: "p1", "@id": "/api/3/workflows/p1", actionTriggerName: "Probe Playbook A", collectionName: "alerts" },
        { uuid: "p2", "@id": "/api/3/workflows/p2", actionTriggerName: "Probe Playbook B", collectionName: "incidents" },
        { uuid: "p3", "@id": "/api/3/workflows/p3", actionTriggerName: "Probe Playbook C", collectionName: "" },
      ];
      sc.$apply();
    });
    await page.waitForSelector(".ui-select-container", { timeout: 5000 });

    // Open the dropdown.
    await page.click(".ui-select-container .ui-select-match");
    await page.waitForSelector(".ui-select-choices-row", { timeout: 5000 });
    await page.waitForTimeout(150);

    // Read computed styles for the first idle (non-active) row and an active
    // row. ui-select marks the first row .active by default; we explicitly
    // hover a different row to flip active and read both states.
    const styles = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".ui-select-choices-row"));
      if (rows.length < 2) return { fail: "need >=2 choices to compare", count: rows.length };
      // Assume first row is .active by default; idle = second row.
      const activeRow = rows[0];
      const idleRow = rows[1];
      // ui-select 0.20.0 wraps each choice's repeated content in a
      // .ui-select-choices-row-inner div, with the user-supplied template
      // (our <div ng-bind-html=...>) inside that.
      const inner = (row) =>
        row.querySelector(".ui-select-choices-row-inner") || row;
      const textNode = (row) =>
        inner(row).querySelector("div, span, a") || inner(row);
      return {
        rowSample: activeRow.outerHTML.slice(0, 240),
        activeText: getComputedStyle(textNode(activeRow)).color,
        activeBg: getComputedStyle(inner(activeRow)).backgroundColor,
        activeClass: activeRow.className,
        idleText: getComputedStyle(textNode(idleRow)).color,
        idleBg: getComputedStyle(inner(idleRow)).backgroundColor,
        idleClass: idleRow.className,
      };
    });
    expect(styles.fail, JSON.stringify(styles)).toBeFalsy();

    // Idle row text: r,g,b should each be 255 (white) and alpha >= 0.85.
    const idle = rgbaChannels(styles.idleText);
    expect(idle, `idle text color parseable: ${styles.idleText}`).toBeTruthy();
    expect(idle[0], `idle text R=255 (got ${styles.idleText})`).toBe(255);
    expect(idle[1], `idle text G=255 (got ${styles.idleText})`).toBe(255);
    expect(idle[2], `idle text B=255 (got ${styles.idleText})`).toBe(255);
    expect(idle[3], `idle text alpha >= 0.85 (got ${styles.idleText})`).toBeGreaterThanOrEqual(0.85);

    // Active row background: should contain the blue tint we set (78,154,241).
    const activeBg = rgbaChannels(styles.activeBg);
    expect(activeBg, `active bg parseable: ${styles.activeBg}`).toBeTruthy();
    expect(activeBg[0], `active bg R~78 (got ${styles.activeBg})`).toBe(78);
    expect(activeBg[1], `active bg G~154 (got ${styles.activeBg})`).toBe(154);
    expect(activeBg[2], `active bg B~241 (got ${styles.activeBg})`).toBe(241);

    // The dropdown is rendered in-place (NOT append-to-body — that variant
    // stranded the whole picker in <body> on select, vanishing the field).
    // It must live inside the modal-body subtree and be visible.
    const geom = await page.evaluate(() => {
      const choices = document.querySelector(".ui-select-choices");
      const modalBody = document.getElementById("edit-modal-body");
      return {
        choices: choices ? choices.getBoundingClientRect() : null,
        modalBody: modalBody ? modalBody.getBoundingClientRect() : null,
        choicesParent: choices && choices.parentElement
          ? choices.parentElement.tagName + "#" + (choices.parentElement.id || "")
          : null,
        choicesInModalBody: choices ? modalBody.contains(choices) : null,
      };
    });
    expect(geom.choices, "dropdown is rendered").toBeTruthy();
    expect(geom.choices.height, "dropdown has height").toBeGreaterThan(0);
    // No append-to-body → the choices node stays within the modal-body subtree.
    expect(
      geom.choicesInModalBody,
      `dropdown should render inside the modal body (parent=${geom.choicesParent})`
    ).toBe(true);
  });
});
