"use strict";
// view.controller tests — jsdom project (see jest.config.js).
// Same bootstrap pattern as the edit controller tests.

global.jasmine = global.jasmine || {};

require("angular");
require("angular-mocks");

angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/view.controller.js");

const CTRL_NAME = "actionRendererWidget100DevCtrl";

const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

let $rootScope, $controller, $q, $timeout;

beforeEach(() => {
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", {});
    $provide.value("$state", { current: { name: "main.viewPanel.detail" }, params: { module: "alerts", id: "1" } });
    $provide.value("API", { ACTION_TRIGGER: "api/triggers/1/action/" });
    $provide.factory("toaster", () => ({
      success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn(),
    }));
    $provide.factory("connectorService", (_$q_) => ({
      executeConnectorAction: jest.fn(() => _$q_.when({ data: {} })),
    }));
    $provide.factory("playbookService", (_$q_) => ({
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => _$q_.when({ result: null })),
    }));
    $provide.factory("FormEntityService", () => ({
      get: jest.fn(() => ({
        module: "alerts",
        originalData: { "@id": "/api/3/alerts/u1", name: "Ada" },
      })),
    }));
    $provide.factory("dynamicValueService", (_$q_) => ({
      evaluateJinja: jest.fn(({ template, values }) =>
        _$q_.when({ result: "RENDERED:" + template })
      ),
    }));
    $provide.factory("$resource", (_$q_) => () => ({
      save: jest.fn(() => ({ $promise: _$q_.when({}) })),
    }));
  });

  ngInject((_$rootScope_, _$controller_, _$q_, _$timeout_) => {
    $rootScope = _$rootScope_;
    $controller = _$controller_;
    $q = _$q_;
    $timeout = _$timeout_;
  });
});

afterEach(() => {
  try { $timeout.verifyNoPendingTasks(); } catch (_) {}
});

// See comment in edit.controller.test.js — controllers lazy-load
// connectorService and playbookService through $injector, so we mock
// $injector with a per-test service map.
function createCtrl({ config = {}, services = {} } = {}) {
  const scope = $rootScope.$new();
  const fakeInjectorMap = {
    connectorService: services.connectorService || {
      executeConnectorAction: jest.fn(() => $q.when({ data: {} })),
    },
    playbookService: services.playbookService || {
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    },
  };
  const $injector = {
    get: (name) => {
      if (name in fakeInjectorMap) return fakeInjectorMap[name];
      throw new Error("Unknown provider: " + name);
    },
  };
  const overrides = { $scope: scope, config, $injector };
  for (const k of Object.keys(services)) {
    if (k === "connectorService" || k === "playbookService") continue;
    overrides[k] = services[k];
  }
  $controller(CTRL_NAME, overrides);
  return { scope };
}

// Drains pending promises and the auto-execute $timeout. Many tests don't
// want the auto-fire so they configure autoExecute=false; the helper still
// flushes if used.
function flush() {
  try { $timeout.flush(); } catch (_) {}
  $rootScope.$apply();
}

// ---------------------------------------------------------------------------

describe("view controller — initialization", () => {
  test("renders nothing-configured message when no source", () => {
    const { scope } = createCtrl({ config: { autoExecute: false } });
    expect(scope.result).toBeNull();
    expect(scope.error).toBeNull();
  });

  test("auto-executes when autoExecute is unset (default true)", () => {
    const exec = jest.fn(() => $q.when({ data: { ok: 1 } }));
    const { scope } = createCtrl({
      config: {
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
      },
      services: { connectorService: { executeConnectorAction: exec } },
    });
    flush();
    expect(exec).toHaveBeenCalled();
    expect(scope.result).toEqual({ ok: 1 });
  });

  test("does not auto-execute when autoExecute=false", () => {
    const exec = jest.fn(() => $q.when({ data: {} }));
    createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
      },
      services: { connectorService: { executeConnectorAction: exec } },
    });
    flush();
    expect(exec).not.toHaveBeenCalled();
  });

  test("error message when source is missing", () => {
    const { scope } = createCtrl({ config: {} });
    scope.refresh();
    flush();
    expect(scope.error).toMatch(/not configured/i);
  });
});

// ---------------------------------------------------------------------------

describe("Jinja-templated parameter resolution", () => {
  test("only string values containing {{ }} are sent to evaluateJinja", () => {
    const evaluateJinja = jest.fn(({ template }) => $q.when({ result: "Ada" }));
    const exec = jest.fn(() => $q.when({ data: {} }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
        params: {
          a: "static",
          b: "{{ vars.input.records[0].name }}",
          n: 42,
        },
      },
      services: {
        dynamicValueService: { evaluateJinja },
        connectorService: { executeConnectorAction: exec },
      },
    });
    scope.refresh();
    flush();
    expect(evaluateJinja).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][4]).toEqual({ a: "static", b: "Ada", n: 42 });
  });

  test("connector result envelope is unwrapped from res.data", () => {
    const exec = jest.fn(() => $q.when({ data: { hits: [1, 2] } }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
      },
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.result).toEqual({ hits: [1, 2] });
  });

  test("connector result without data envelope passes through", () => {
    const exec = jest.fn(() => $q.when({ raw: "no envelope" }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
      },
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    // Object owns 'data' check uses hasOwnProperty; res without `data` returns res.
    expect(scope.result).toEqual({ raw: "no envelope" });
  });
});

// ---------------------------------------------------------------------------

describe("output mode — table", () => {
  function setupWithTable(tableCfg, sample) {
    const exec = jest.fn(() => $q.when({ data: sample }));
    return createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
        output: { mode: "table", table: tableCfg, jinjaTemplate: "" },
      },
      services: { connectorService: { executeConnectorAction: exec } },
    });
  }

  test("auto mode infers union of keys from array of objects", () => {
    const { scope } = setupWithTable(
      { rootPath: "rows", mode: "auto", columns: [] },
      { rows: [{ a: 1 }, { a: 2, b: 3 }] }
    );
    scope.refresh();
    flush();
    expect(scope.tableHeaders.sort()).toEqual(["a", "b"]);
    expect(scope.tableRows.length).toBe(2);
  });

  test("auto mode for array of primitives uses 'value' column", () => {
    const { scope } = setupWithTable(
      { rootPath: "list", mode: "auto", columns: [] },
      { list: ["x", "y", "z"] }
    );
    scope.refresh();
    flush();
    expect(scope.tableHeaders).toEqual(["value"]);
    expect(scope.tableRows).toEqual([["x"], ["y"], ["z"]]);
  });

  test("auto mode wraps single object as one row", () => {
    const { scope } = setupWithTable(
      { rootPath: "meta", mode: "auto", columns: [] },
      { meta: { count: 3, status: "ok" } }
    );
    scope.refresh();
    flush();
    expect(scope.tableHeaders.sort()).toEqual(["count", "status"]);
    expect(scope.tableRows.length).toBe(1);
  });

  test("columns mode renders explicit paths and headers", () => {
    const { scope } = setupWithTable(
      {
        rootPath: "data.hits",
        mode: "columns",
        columns: [
          { path: "id", header: "ID" },
          { path: "score", header: "Score" },
          { path: "tags[0]", header: "Top tag" },
        ],
      },
      { data: { hits: [
        { id: 1, score: 10, tags: ["a", "b"] },
        { id: 2, score: 20, tags: ["c"] },
      ] } }
    );
    scope.refresh();
    flush();
    expect(scope.tableHeaders).toEqual(["ID", "Score", "Top tag"]);
    expect(scope.tableRows).toEqual([
      ["1", "10", "a"],
      ["2", "20", "c"],
    ]);
  });

  test("missing path produces empty headers (warning surfaced in template)", () => {
    const { scope } = setupWithTable(
      { rootPath: "missing.deep.path", mode: "auto", columns: [] },
      { other: 1 }
    );
    scope.refresh();
    flush();
    expect(scope.tableHeaders).toEqual([]);
    expect(scope.tableRows).toEqual([]);
  });

  test("nested objects in cells are stringified", () => {
    const { scope } = setupWithTable(
      { rootPath: "rows", mode: "auto", columns: [] },
      { rows: [{ payload: { a: 1, b: 2 } }] }
    );
    scope.refresh();
    flush();
    expect(scope.tableRows[0][0]).toContain('"a":1');
  });
});

// ---------------------------------------------------------------------------

describe("output mode — jinja", () => {
  test("renders configured template with executed result in vars.input.result", () => {
    const evaluateJinja = jest.fn(({ template, values }) => {
      // First call: param resolution (none); second: template render.
      return $q.when({ result: "<p>" + values.vars.input.result.greeting + "</p>" });
    });
    const exec = jest.fn(() => $q.when({ data: { greeting: "Hello" } }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
        output: {
          mode: "jinja",
          jinjaTemplate: "<p>{{ vars.input.result.greeting }}</p>",
          table: { rootPath: "", mode: "auto", columns: [] },
        },
      },
      services: {
        connectorService: { executeConnectorAction: exec },
        dynamicValueService: { evaluateJinja },
      },
    });
    scope.refresh();
    flush();
    expect(scope.renderedHtml).toBe("<p>Hello</p>");
    // evaluateJinja called exactly once for template render (no param Jinja).
    expect(evaluateJinja).toHaveBeenCalledTimes(1);
    expect(evaluateJinja.mock.calls[0][0].values.vars.input.result).toEqual({ greeting: "Hello" });
  });

  test("template render error sets scope.error", () => {
    const evaluateJinja = jest.fn(() => $q.reject({ data: { message: "syntax" } }));
    const exec = jest.fn(() => $q.when({ data: { ok: 1 } }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
        output: {
          mode: "jinja",
          jinjaTemplate: "{{ broken",
          table: { rootPath: "", mode: "auto", columns: [] },
        },
      },
      services: {
        connectorService: { executeConnectorAction: exec },
        dynamicValueService: { evaluateJinja },
      },
    });
    scope.refresh();
    flush();
    expect(scope.error).toMatch(/syntax/);
  });
});

// ---------------------------------------------------------------------------

describe("playbook source dispatch", () => {
  test("playbook trigger uses ACTION_TRIGGER + route", () => {
    const save = jest.fn(() => ({ $promise: $q.when({ task_id: "t-1" }) }));
    const $resource = jest.fn(() => ({ save }));
    // Resolve immediately without webhook subscribe by stubbing the success
    // callback path: checkPlaybookExecutionCompletion(taskIds, success, err, scope).
    const checkPlaybookExecutionCompletion = jest.fn((taskIds, success) => {
      success({ status: "finished", instance_ids: 99 });
    });
    const getExecutedPlaybookLogData = jest.fn(() => $q.when({ result: { hello: "world" } }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: {
          kind: "playbook",
          uuid: "u1",
          iri: "/api/3/workflows/u1",
          route: "abc-123",
          singleRecordExecution: true,
        },
        params: { name: "Ada" },
      },
      services: {
        $resource,
        playbookService: { checkPlaybookExecutionCompletion, getExecutedPlaybookLogData },
      },
    });
    scope.refresh();
    flush();
    expect($resource).toHaveBeenCalledWith("api/triggers/1/action/abc-123");
    // Body should include the param plus record metadata + singleRecordExecution.
    const body = save.mock.calls[0][0];
    expect(body.name).toBe("Ada");
    expect(body.records).toEqual(["/api/3/alerts/u1"]);
    expect(body.__resource).toBe("alerts");
    expect(body.__uuid).toBe("u1");
    expect(body.singleRecordExecution).toBe(true);
    expect(getExecutedPlaybookLogData).toHaveBeenCalledWith(99);
    expect(scope.result).toEqual({ hello: "world" });
  });
});
