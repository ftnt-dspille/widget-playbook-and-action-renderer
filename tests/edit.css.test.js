"use strict";
// Edit-modal CSS contract — playbook picker must not paint over modal chrome.
//
// Regression for "the exit button is gone on the action render edit controller":
// the open ui-select dropdown carried a global z-index:1100, which is above
// bootstrap's 1050 modal layer, so when opened it rendered over SOAR's injected
// modal header and covered the × exit/close button. The fix scopes the dropdown
// inside its container's local stacking context (container gets a non-auto
// z-index) and drops the choices z-index to a sibling-level value.

const fs = require("fs");
const path = require("path");

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "widget", "widgetAssets", "css", "actionRenderer.css"),
  "utf8"
);

// Grab the declaration block for a selector (first match).
function block(selector) {
  const idx = CSS.indexOf(selector);
  if (idx === -1) return null;
  const open = CSS.indexOf("{", idx);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

describe("edit modal — playbook picker stacking", () => {
  test("ui-select-choices z-index stays below the bootstrap modal layer (1050)", () => {
    const decl = block(".ui-select-bootstrap > .ui-select-choices");
    expect(decl).not.toBeNull();
    const m = decl.match(/z-index:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThan(1050);
  });

  test("ui-select-container forms a local stacking context so the dropdown can't escape over modal chrome", () => {
    const decl = block(".action-renderer-edit .form-group .ui-select-container");
    expect(decl).not.toBeNull();
    expect(decl).toMatch(/position:\s*relative/);
    expect(decl).toMatch(/z-index:\s*\d+/);
  });
});
