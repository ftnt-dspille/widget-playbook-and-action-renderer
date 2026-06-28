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

describe("edit modal — source toggle + match-meta layout", () => {
  test("active source toggle (.btn-primary) gets an explicit accent (dark-theme btn-primary is too dark to read as selected)", () => {
    const decl = block(".action-renderer-edit .btn-group > .btn.btn-primary");
    expect(decl).not.toBeNull();
    expect(decl).toMatch(/background-color:\s*#337ab7/i);
    expect(decl).toMatch(/color:\s*#fff/i);
  });

  test("match text flows inline (block container, inline children) so the version hugs the name and the name can't be clipped to nothing", () => {
    const textDecl = block(".action-renderer-edit .ui-select-bootstrap .ui-select-match-text");
    expect(textDecl).toMatch(/display:\s*block/);
    // The match spans are forced back to inline + auto width with !important to
    // beat the themed inline-block/50%-width rule that drifted the version right.
    const spanDecl = block(".ui-select-match-text .ar-match-label");
    expect(spanDecl).toMatch(/display:\s*inline\s*!important/);
    expect(spanDecl).toMatch(/width:\s*auto\s*!important/);
  });
});

describe("edit modal — body height cap keeps the platform Save footer in view", () => {
  // Regression for "we can't see the Save button on the widget in FortiSOAR":
  // the widget ships its own .modal-body (.action-renderer-body) wrapped in a
  // <form>, which breaks SOAR's modal flex height chain. On a tall step (Output)
  // the body grew unbounded, the modal exceeded the viewport, and the injected
  // Cancel/Save footer was pushed off the bottom edge. Cap + scroll the body.
  test(".action-renderer-body caps its height and scrolls internally", () => {
    const decl = block(".action-renderer-body");
    expect(decl).not.toBeNull();
    expect(decl).toMatch(/max-height:/);
    expect(decl).toMatch(/overflow-y:\s*auto/);
  });
});
