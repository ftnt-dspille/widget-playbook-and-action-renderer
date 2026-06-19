"use strict";
// view.html template contract.
//
// The table style presets and sticky-header option are pure config->class
// bindings in view.html (no controller logic), so the controller tests can't
// reach them. The DOM rendering itself is exercised by the e2e specs against a
// live host; this contract test guards the wiring cheaply and offline so a
// template edit can't silently drop an option (e.g. remove the style class and
// every preset would degrade to 'striped' with no test going red).

const fs = require("fs");
const path = require("path");

const WIDGET_DIR = path.join(__dirname, "..", "widget");
const viewHtml = fs.readFileSync(path.join(WIDGET_DIR, "view.html"), "utf8");

describe("view.html — output-option bindings", () => {
  test("each output mode has its own render block", () => {
    expect(viewHtml).toContain("outputMode === 'raw'");
    expect(viewHtml).toContain("outputMode === 'table'");
    expect(viewHtml).toContain("outputMode === 'jinja'");
  });

  test("table style preset is bound from config with a 'striped' default", () => {
    expect(viewHtml).toContain("action-renderer-table-style-' + (config.output.table.style || 'striped')");
  });

  test("sticky-header class is toggled from config.output.table.stickyHeader", () => {
    expect(viewHtml).toContain("'action-renderer-table-sticky': config.output.table.stickyHeader");
  });

  test("header and cell alignment are driven by tableColumnAlign()", () => {
    const aligns = viewHtml.match(/tableColumnAlign\(\$index\)/g) || [];
    // One for <th>, one for <td>.
    expect(aligns.length).toBe(2);
  });

  test("empty-rows fallback uses the configurable emptyMessage", () => {
    expect(viewHtml).toContain("config.output.table.emptyMessage || 'No rows'");
  });

  test("the unresolved-path warning surfaces the configured rootPath", () => {
    expect(viewHtml).toContain("config.output.table.rootPath");
    expect(viewHtml).toContain("did not resolve");
  });

  test("raw mode renders resultJsonText in a <pre>", () => {
    expect(viewHtml).toMatch(/action-renderer-result-raw[^>]*>\{\{\s*resultJsonText\s*\}\}/);
  });

  test("jinja mode renders through the sandboxed html-preview directive", () => {
    expect(viewHtml).toContain("data-action-renderer-html-preview=\"renderedHtml\"");
  });

  test("the unconfigured, error, and loading banners are all present", () => {
    expect(viewHtml).toContain("!config.source || !config.source.kind");
    expect(viewHtml).toMatch(/alert alert-danger"[^>]*data-ng-if="error"/);
    expect(viewHtml).toContain("loading && !error");
  });

  test("the Run button is disabled while loading", () => {
    expect(viewHtml).toMatch(/data-ng-click="refresh\(\)"[\s\S]*?data-ng-disabled="loading"/);
  });
});

describe("view.html — referenced CSS style presets exist", () => {
  const css = fs.readFileSync(
    path.join(WIDGET_DIR, "widgetAssets", "css", "actionRenderer.css"),
    "utf8"
  );
  // Every preset the editor can pick must have a matching style rule, else the
  // class is bound but visually inert.
  for (const preset of ["striped", "plain", "bordered", "compact", "card"]) {
    test(`style preset '${preset}' has a CSS rule`, () => {
      expect(css).toContain("action-renderer-table-style-" + preset);
    });
  }

  test("sticky-header has a CSS rule", () => {
    expect(css).toContain("action-renderer-table-sticky");
  });

  // Customer report: large/wide connector responses overflowed off the right
  // and bottom in the view panel AND the edit "Run sample" pane. The fix wraps
  // every result <pre> and constrains the widget so the inner table is the only
  // horizontal scroller. Pin the wrap discipline so it can't silently regress.
  for (const cls of ["action-renderer-result-raw", "action-renderer-sample", "action-renderer-preview"]) {
    test(`'${cls}' wraps long content instead of overflowing`, () => {
      const block = css.slice(css.indexOf("." + cls));
      expect(block).toContain("white-space: pre-wrap");
      expect(block).toMatch(/word-break:\s*break-word/);
    });
  }

  test("widget container is shrink-safe and clips horizontal overflow to the table wrap", () => {
    const block = css.slice(css.indexOf(".action-renderer-widget {"));
    expect(block).toContain("min-width: 0");
    expect(block).toContain("overflow-x: hidden");
  });

  test("table wrap scrolls oversized tables on both axes", () => {
    expect(css).toMatch(/\.action-renderer-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.action-renderer-table-wrap\s*\{[^}]*overflow-y:\s*auto/);
  });
});
