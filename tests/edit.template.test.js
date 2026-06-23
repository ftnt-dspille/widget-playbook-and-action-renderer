"use strict";
// edit.html structural contract.
//
// Regression: a stray extra </div> closed .modal-body BEFORE the Back/Next nav,
// so the browser's HTML parser reparented .action-renderer-nav out of the modal
// body. On the Output step (tall content) the nav floated over the Table Mode
// section — Back/Next overlapping the controls, the nav separator line landing
// mid-form. These cheap offline checks guard the nesting so a future edit can't
// silently reintroduce the imbalance.

const fs = require("fs");
const path = require("path");

const WIDGET_DIR = path.join(__dirname, "..", "widget");
const editHtml = fs.readFileSync(path.join(WIDGET_DIR, "edit.html"), "utf8");
// Strip HTML comments so commented-out markup doesn't skew the tag count.
const stripped = editHtml.replace(/<!--[\s\S]*?-->/g, "");

describe("edit.html — structural integrity", () => {
  test("div tags are balanced", () => {
    const opens = (stripped.match(/<div\b/g) || []).length;
    const closes = (stripped.match(/<\/div>/g) || []).length;
    expect(closes).toBe(opens);
  });

  test("the Back/Next nav is nested inside .modal-body (survives SOAR chrome strip)", () => {
    const bodyOpen = stripped.indexOf('class="modal-body');
    const nav = stripped.indexOf('class="action-renderer-nav"');
    const formClose = stripped.indexOf("</form>");
    expect(bodyOpen).toBeGreaterThanOrEqual(0);
    expect(nav).toBeGreaterThan(bodyOpen);
    expect(nav).toBeLessThan(formClose);
    // Between the nav and </form> there must be at least two </div> — one closing
    // the nav and one closing .modal-body — proving the body wraps the nav.
    const tail = stripped.slice(nav, formClose);
    const tailCloses = (tail.match(/<\/div>/g) || []).length;
    expect(tailCloses).toBeGreaterThanOrEqual(2);
  });

  test("connector picker is a searchable ui-select bound to picks.connectorPicked", () => {
    expect(stripped).toMatch(/<ui-select[^>]*data-ng-model="picks\.connectorPicked"/);
    expect(stripped).toContain('data-on-select="onConnectorPicked()"');
    // The old plain <select ng-options> must be gone.
    expect(stripped).not.toMatch(/<select[^>]*data-ng-model="picks\.connectorPicked"/);
  });
});
