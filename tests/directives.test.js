"use strict";
// directives.js — the render-side of the widget's Jinja output mode.
// Two directives, both compiled here against a real angular module:
//   • actionRendererHtmlPreview — sandboxed iframe that wraps bare tr/td/th
//     fragments in <table>, mirrors page stylesheets, and never executes script.
//   • actionRendererJinjaPane — the inline render pane: tab auto-selection,
//     output formatting (object/JSON-string/plain), and render() success/error.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/directives.js");

const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

let $rootScope, $compile, $q, $timeout, evaluateJinja, modulesGet, toaster;

beforeEach(() => {
  evaluateJinja = jest.fn();
  modulesGet = jest.fn(() => ({ $promise: { then: () => {} } }));
  toaster = { warning: jest.fn(), error: jest.fn() };
  ngModule("cybersponse", ($provide) => {
    $provide.value("$state", { params: {} });
    $provide.value("toaster", toaster);
    $provide.value("Modules", { get: modulesGet });
    $provide.value("dynamicValueService", { evaluateJinja });
  });
  ngInject((_$rootScope_, _$compile_, _$q_, _$timeout_) => {
    $rootScope = _$rootScope_;
    $compile = _$compile_;
    $q = _$q_;
    $timeout = _$timeout_;
  });
});

function compile(html, scopeVars) {
  const scope = $rootScope.$new();
  Object.assign(scope, scopeVars || {});
  const el = $compile(html)(scope);
  scope.$apply();
  return { el, scope };
}

// ---------------------------------------------------------------------------
// actionRendererHtmlPreview
// ---------------------------------------------------------------------------
describe("actionRendererHtmlPreview", () => {
  function iframeDoc(htmlValue) {
    const { el } = compile('<div data-action-renderer-html-preview="h"></div>', { h: htmlValue });
    const iframe = el[0].querySelector("iframe");
    return { iframe, srcdoc: iframe.getAttribute("srcdoc") || iframe.srcdoc };
  }

  test("renders a sandboxed, no-referrer iframe", () => {
    const { iframe } = iframeDoc("<p>hi</p>");
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("wraps a bare <tr> fragment in a <table>", () => {
    const { srcdoc } = iframeDoc("<tr><td>1</td></tr>");
    expect(srcdoc).toContain("<table><tr><td>1</td></tr></table>");
  });

  test("wraps a bare <td> fragment in a <table>", () => {
    const { srcdoc } = iframeDoc("<td>cell</td>");
    expect(srcdoc).toContain("<table><td>cell</td></table>");
  });

  test("does NOT wrap content that already starts with a block element", () => {
    const { srcdoc } = iframeDoc("<div><tr></tr></div>");
    expect(srcdoc).toContain("<div><tr></tr></div>");
    expect(srcdoc).not.toContain("<table><div>");
  });

  test("empty/null html yields a document without throwing", () => {
    const { srcdoc } = iframeDoc(null);
    expect(typeof srcdoc).toBe("string");
    expect(srcdoc).toContain("<body>");
  });

  test("collects page stylesheet links into the iframe head", () => {
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "theme.css");
    document.head.appendChild(link);
    const { srcdoc } = iframeDoc("<p>x</p>");
    expect(srcdoc).toMatch(/<link rel="stylesheet" href="[^"]*theme\.css"/);
    document.head.removeChild(link);
  });

  test("re-renders when the bound html changes", () => {
    const { el, scope } = compile('<div data-action-renderer-html-preview="h"></div>', { h: "<p>one</p>" });
    const iframe = el[0].querySelector("iframe");
    scope.h = "<p>two</p>";
    scope.$apply();
    const srcdoc = iframe.getAttribute("srcdoc") || iframe.srcdoc;
    expect(srcdoc).toContain("<p>two</p>");
  });
});

// ---------------------------------------------------------------------------
// actionRendererJinjaPane
// ---------------------------------------------------------------------------
describe("actionRendererJinjaPane", () => {
  function pane(scopeVars) {
    const { el } = compile(
      '<div data-action-renderer-jinja-pane data-seed-input="seed" data-template="tpl"></div>',
      scopeVars
    );
    // The directive has an isolate scope; reach it for assertions.
    return { el, iso: window.angular.element(el).isolateScope() };
  }

  test("seed input is pretty-printed into the read-only pane", () => {
    const { iso } = pane({ seed: { a: 1 }, tpl: "" });
    expect(iso.seedJsonText).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test("setTab switches the active output tab", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.setTab("html");
    expect(iso.outputTab).toBe("html");
  });

  test("object output auto-selects the JSON tab and pretty-prints", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.output = { x: 1 };
    iso.$apply();
    expect(iso.outputTab).toBe("json");
    expect(iso.outputDisplay).toBe(JSON.stringify({ x: 1 }, null, 2));
  });

  test("HTML-looking string output auto-selects the HTML tab", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.output = "<div>hello</div>";
    iso.$apply();
    expect(iso.outputTab).toBe("html");
  });

  test("plain string output auto-selects the Raw tab", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.output = "just text";
    iso.$apply();
    expect(iso.outputTab).toBe("raw");
    expect(iso.outputDisplay).toBe("just text");
  });

  test("a JSON-string output is reparsed and pretty-printed in the display", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.output = '{"k":1}';
    iso.$apply();
    expect(iso.outputDisplay).toBe(JSON.stringify({ k: 1 }, null, 2));
  });

  test("render() with an empty template warns and does not call the service", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.render();
    expect(toaster.warning).toHaveBeenCalled();
    expect(evaluateJinja).not.toHaveBeenCalled();
  });

  test("render() success sets output from the service result", () => {
    evaluateJinja.mockImplementation(() => $q.when({ result: "<b>ok</b>" }));
    const { iso } = pane({ seed: { v: 1 }, tpl: "{{ v }}" });
    iso.render();
    iso.$apply();
    expect(iso.output).toBe("<b>ok</b>");
    expect(iso.isError).toBe(false);
    expect(iso.rendering).toBe(false);
  });

  test("render() passes seed as vars.input.result", () => {
    let captured;
    evaluateJinja.mockImplementation((arg) => { captured = arg; return $q.when({ result: "x" }); });
    const { iso } = pane({ seed: { hit: 2 }, tpl: "{{ x }}" });
    iso.render();
    iso.$apply();
    expect(captured.values.vars.input.result).toEqual({ hit: 2 });
  });

  test("render() error sets an error message and flag", () => {
    evaluateJinja.mockImplementation(() => $q.reject({ data: { message: "bad jinja" } }));
    const { iso } = pane({ seed: null, tpl: "{{ broken" });
    iso.render();
    iso.$apply();
    expect(iso.isError).toBe(true);
    expect(iso.output).toMatch(/bad jinja/);
    expect(iso.rendering).toBe(false);
  });

  test("executedSample event seeds the input pane", () => {
    const { iso } = pane({ seed: null, tpl: "" });
    iso.$broadcast("actionRenderer:executedSample", { fresh: true });
    iso.$apply();
    expect(iso.seedInput).toEqual({ fresh: true });
    expect(iso.seedJsonText).toContain("fresh");
  });
});
