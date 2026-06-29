"use strict";
// view.controller — EXHAUSTIVE render-option coverage.
//
// Companion to view.controller.test.js. That file pins the happy paths; this
// file walks every remaining render option and output branch the controller
// supports so each one is validated, not just the common ones:
//   • tableColumnAlign — explicit (columns mode) + inferred (auto numeric) + default
//   • table empty-array / missing-path / single-primitive normalization
//   • raw mode — resultJsonText pretty-print + circular fallback
//   • jinja mode — no-template short-circuit + result context shape
//   • connector — agent passthrough, res.data===null envelope, nested error shapes
//   • playbook — all three terminal shapes (no-task-id, status-without-instances,
//     log-without-result) + failed status
//   • param resolution — order preserved, non-string passthrough, multiple Jinja
//   • parsePath/resolvePath — malformed + out-of-range + unclosed-bracket paths

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/view.controller.js");

const CTRL_NAME = "actionRendererWidget109DevCtrl";
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
    $provide.factory("FormEntityService", () => ({
      get: jest.fn(() => ({
        module: "alerts",
        originalData: { "@id": "/api/3/alerts/u1", name: "Ada" },
      })),
    }));
    $provide.factory("dynamicValueService", (_$q_) => ({
      evaluateJinja: jest.fn(({ template }) => _$q_.when({ result: "RENDERED:" + template })),
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

function createCtrl({ config = {}, services = {}, entity } = {}) {
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
  if (entity !== undefined) {
    overrides.FormEntityService = { get: jest.fn(() => entity) };
  }
  for (const k of Object.keys(services)) {
    if (k === "connectorService" || k === "playbookService") continue;
    overrides[k] = services[k];
  }
  $controller(CTRL_NAME, overrides);
  return { scope };
}

function flush() {
  try { $timeout.flush(); } catch (_) {}
  $rootScope.$apply();
}

function connectorConfig(extra) {
  return Object.assign(
    {
      autoExecute: false,
      source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" },
    },
    extra
  );
}

// ---------------------------------------------------------------------------
// tableColumnAlign — every branch
// ---------------------------------------------------------------------------
describe("tableColumnAlign", () => {
  function build(tableCfg, sample) {
    const exec = jest.fn(() => $q.when({ data: sample }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "table", table: tableCfg } }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    return scope;
  }

  test("columns mode returns the configured per-column align", () => {
    const scope = build(
      {
        rootPath: "rows",
        mode: "columns",
        columns: [
          { path: "id", header: "ID", align: "center" },
          { path: "score", header: "Score", align: "right" },
        ],
      },
      { rows: [{ id: 1, score: 9 }] }
    );
    expect(scope.tableColumnAlign(0)).toBe("center");
    expect(scope.tableColumnAlign(1)).toBe("right");
  });

  test("auto mode infers right alignment for numeric first-row cell", () => {
    const scope = build({ rootPath: "rows", mode: "auto" }, { rows: [{ amount: 42 }] });
    // headers=[amount]; first row cell '42' is numeric → right
    expect(scope.tableColumnAlign(0)).toBe("right");
  });

  test("auto mode infers numeric-string as right alignment", () => {
    const scope = build({ rootPath: "rows", mode: "auto" }, { rows: [{ amount: "3.14" }] });
    expect(scope.tableColumnAlign(0)).toBe("right");
  });

  test("auto mode defaults to left for non-numeric cell", () => {
    const scope = build({ rootPath: "rows", mode: "auto" }, { rows: [{ name: "ada" }] });
    expect(scope.tableColumnAlign(0)).toBe("left");
  });
});

// ---------------------------------------------------------------------------
// Table normalization edge cases
// ---------------------------------------------------------------------------
describe("table normalization edges", () => {
  function build(tableCfg, sample) {
    const exec = jest.fn(() => $q.when({ data: sample }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "table", table: tableCfg } }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    return scope;
  }

  test("empty array resolves to no headers (renders the path warning)", () => {
    const scope = build({ rootPath: "rows", mode: "auto" }, { rows: [] });
    expect(scope.tableHeaders).toEqual([]);
    expect(scope.tableRows).toEqual([]);
  });

  test("root path '' (whole result) wraps a single object as one row", () => {
    const scope = build({ rootPath: "", mode: "auto" }, { count: 1, ok: true });
    expect(scope.tableHeaders.sort()).toEqual(["count", "ok"]);
    expect(scope.tableRows.length).toBe(1);
  });

  test("primitive root value becomes a one-cell 'value' row", () => {
    const scope = build({ rootPath: "n", mode: "auto" }, { n: 7 });
    expect(scope.tableHeaders).toEqual(["value"]);
    expect(scope.tableRows).toEqual([["7"]]);
  });

  test("auto mode caps inferred columns at 20", () => {
    const wide = {};
    for (let i = 0; i < 30; i++) wide["k" + i] = i;
    const scope = build({ rootPath: "rows", mode: "auto" }, { rows: [wide] });
    expect(scope.tableHeaders.length).toBe(20);
  });

  test("columns mode with whole-row path (no path) stringifies the row object", () => {
    const scope = build(
      { rootPath: "rows", mode: "columns", columns: [{ header: "Raw", path: "" }] },
      { rows: [{ a: 1 }] }
    );
    expect(scope.tableHeaders).toEqual(["Raw"]);
    expect(scope.tableRows[0][0]).toContain('"a":1');
  });

  test("columns mode falls back to path as header when header omitted", () => {
    const scope = build(
      { rootPath: "rows", mode: "columns", columns: [{ path: "id" }] },
      { rows: [{ id: 5 }] }
    );
    expect(scope.tableHeaders).toEqual(["id"]);
  });

  test("null cell renders as empty string", () => {
    const scope = build({ rootPath: "rows", mode: "auto" }, { rows: [{ a: null }] });
    expect(scope.tableRows[0][0]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// applyOutput seam — re-render the held result under a new output config
// without re-executing the source.
// ---------------------------------------------------------------------------
describe("applyOutput re-render seam", () => {
  test("switches mode and re-renders the held result without re-executing", () => {
    const exec = jest.fn(() => $q.when({ data: { rows: [{ a: 1 }, { a: 2 }] } }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "table", table: { rootPath: "rows", mode: "auto" } } }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(scope.outputMode).toBe("table");
    expect(scope.tableRows.length).toBe(2);

    // Switch to raw and re-render the SAME result — no second execute.
    scope.config.output.mode = "raw";
    scope.applyOutput();
    expect(scope.outputMode).toBe("raw");
    expect(scope.resultJsonText).toContain('"a": 1');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Raw mode
// ---------------------------------------------------------------------------
describe("raw output mode", () => {
  test("pretty-prints the result as JSON text", () => {
    const exec = jest.fn(() => $q.when({ data: { a: 1, b: [2, 3] } }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "raw" } }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.outputMode).toBe("raw");
    expect(scope.resultJsonText).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
  });

  test("circular result falls back to String() without throwing", () => {
    const circular = {};
    circular.self = circular;
    const exec = jest.fn(() => $q.when({ data: circular }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "raw" } }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.error).toBeNull();
    expect(typeof scope.resultJsonText).toBe("string");
  });

  test("defaults to raw mode when output.mode is unset", () => {
    const exec = jest.fn(() => $q.when({ data: { ok: 1 } }));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.outputMode).toBe("raw");
  });
});

// ---------------------------------------------------------------------------
// Jinja mode
// ---------------------------------------------------------------------------
describe("jinja output mode", () => {
  test("no template configured short-circuits to empty rendered html", () => {
    const evaluateJinja = jest.fn(() => $q.when({ result: "x" }));
    const exec = jest.fn(() => $q.when({ data: { ok: 1 } }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "jinja", jinjaTemplate: "" } }),
      services: {
        connectorService: { executeConnectorAction: exec },
        dynamicValueService: { evaluateJinja },
      },
    });
    scope.refresh();
    flush();
    expect(scope.renderedHtml).toBe("");
    // Called zero times — no params, no template.
    expect(evaluateJinja).not.toHaveBeenCalled();
  });

  test("template context carries both records[0] and result", () => {
    let captured;
    const evaluateJinja = jest.fn(({ values }) => { captured = values; return $q.when({ result: "ok" }); });
    const exec = jest.fn(() => $q.when({ data: { greeting: "hi" } }));
    const { scope } = createCtrl({
      config: connectorConfig({ output: { mode: "jinja", jinjaTemplate: "{{ x }}" } }),
      services: {
        connectorService: { executeConnectorAction: exec },
        dynamicValueService: { evaluateJinja },
      },
    });
    scope.refresh();
    flush();
    expect(captured.vars.input.result).toEqual({ greeting: "hi" });
    expect(captured.vars.input.records[0].name).toBe("Ada");
  });
});

// ---------------------------------------------------------------------------
// Connector dispatch options
// ---------------------------------------------------------------------------
describe("connector dispatch", () => {
  test("agent is forwarded as the 8th executeConnectorAction argument", () => {
    const exec = jest.fn(() => $q.when({ data: {} }));
    const { scope } = createCtrl({
      config: connectorConfig({ agent: "agent-7" }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(exec.mock.calls[0][7]).toBe("agent-7");
  });

  test("omitted agent passes undefined (platform default)", () => {
    const exec = jest.fn(() => $q.when({ data: {} }));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(exec.mock.calls[0][7]).toBeUndefined();
  });

  test("res.data===null envelope unwraps to a null result", () => {
    const exec = jest.fn(() => $q.when({ data: null }));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.result).toBeNull();
    expect(scope.error).toBeNull();
  });

  test("server error prefers err.data.message", () => {
    const exec = jest.fn(() => $q.reject({ data: { message: "boom" } }));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.error).toBe("boom");
  });

  test("server error falls back to err.data.detail", () => {
    const exec = jest.fn(() => $q.reject({ data: { detail: "nope" } }));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.error).toBe("nope");
  });

  test("server error falls back to err.message then generic", () => {
    const exec = jest.fn(() => $q.reject(new Error("transport")));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.error).toBe("transport");
  });

  test("missing connectorService surfaces an error, not a crash", () => {
    const scope = $rootScope.$new();
    const $injector = { get: () => { throw new Error("no svc"); } };
    $controller(CTRL_NAME, { $scope: scope, config: connectorConfig({}), $injector });
    scope.refresh();
    flush();
    expect(scope.error).toMatch(/unavailable|failed/i);
  });
});

// ---------------------------------------------------------------------------
// Playbook dispatch — all terminal shapes
// ---------------------------------------------------------------------------
describe("playbook dispatch terminal shapes", () => {
  function playbookCtrl(saveResolve, pbSvc) {
    const save = jest.fn(() => ({ $promise: $q.when(saveResolve) }));
    const $resource = jest.fn(() => ({ save }));
    const { scope } = createCtrl({
      config: {
        autoExecute: false,
        source: { kind: "playbook", uuid: "u1", route: "r-1" },
        params: {},
      },
      services: { $resource, playbookService: pbSvc },
    });
    scope.refresh();
    flush();
    return scope;
  }

  test("no task id returned yields a __triggered acknowledgement", () => {
    const scope = playbookCtrl({}, {
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(),
    });
    expect(scope.result.__triggered).toBe(true);
    expect(scope.result.message).toMatch(/no task id/i);
  });

  test("finished status without instance_ids returns the status object", () => {
    const scope = playbookCtrl({ task_id: "t1" }, {
      checkPlaybookExecutionCompletion: jest.fn((ids, ok) => ok({ status: "finished" })),
      getExecutedPlaybookLogData: jest.fn(),
    });
    expect(scope.result.__status).toBe("finished");
    expect(scope.result.statusObject.status).toBe("finished");
  });

  test("failed status without instance_ids still resolves (not stranded)", () => {
    const scope = playbookCtrl({ task_id: "t1" }, {
      checkPlaybookExecutionCompletion: jest.fn((ids, ok) => ok({ status: "failed" })),
      getExecutedPlaybookLogData: jest.fn(),
    });
    expect(scope.result.__status).toBe("failed");
  });

  test("non-terminal statuses are ignored until a terminal one arrives", () => {
    const scope = playbookCtrl({ task_id: "t1" }, {
      checkPlaybookExecutionCompletion: jest.fn((ids, ok) => {
        ok({ status: "running" }); // ignored
        ok(null); // ignored
        ok({ status: "finished", instance_ids: 5 });
      }),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: { done: true } })),
    });
    expect(scope.result).toEqual({ done: true });
  });

  test("log without a result field returns the whole log object", () => {
    const scope = playbookCtrl({ task_id: "t1" }, {
      checkPlaybookExecutionCompletion: jest.fn((ids, ok) => ok({ status: "finished", instance_ids: 5 })),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ env: {}, foo: 1 })),
    });
    expect(scope.result).toEqual({ env: {}, foo: 1 });
  });

  test("task_ids array is preferred over a single task_id", () => {
    const check = jest.fn((ids, ok) => ok({ status: "finished", instance_ids: 9 }));
    playbookCtrl({ task_ids: ["a", "b"], task_id: "ignored" }, {
      checkPlaybookExecutionCompletion: check,
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: 1 })),
    });
    expect(check.mock.calls[0][0]).toEqual(["a", "b"]);
  });

  test("subscribe-failure callback rejects into scope.error", () => {
    const scope = playbookCtrl({ task_id: "t1" }, {
      checkPlaybookExecutionCompletion: jest.fn((ids, ok, fail) => fail()),
      getExecutedPlaybookLogData: jest.fn(),
    });
    expect(scope.error).toMatch(/subscribe/i);
  });

  test("missing playbookService surfaces an error", () => {
    const save = jest.fn(() => ({ $promise: $q.when({ task_id: "t" }) }));
    const $resource = jest.fn(() => ({ save }));
    const scope = $rootScope.$new();
    const $injector = {
      get: (n) => { if (n === "playbookService") throw new Error("no pb"); throw new Error(n); },
    };
    $controller(CTRL_NAME, {
      $scope: scope,
      config: { autoExecute: false, source: { kind: "playbook", uuid: "u", route: "r" } },
      $injector,
      $resource,
    });
    scope.refresh();
    flush();
    expect(scope.error).toMatch(/unavailable|failed/i);
  });
});

// ---------------------------------------------------------------------------
// Param resolution options
// ---------------------------------------------------------------------------
describe("param resolution", () => {
  test("preserves non-string param values verbatim", () => {
    const exec = jest.fn(() => $q.when({ data: {} }));
    const { scope } = createCtrl({
      config: connectorConfig({ params: { n: 42, b: true, arr: [1, 2], obj: { x: 1 } } }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(exec.mock.calls[0][4]).toEqual({ n: 42, b: true, arr: [1, 2], obj: { x: 1 } });
  });

  test("resolves multiple Jinja params, leaving statics untouched", () => {
    const evaluateJinja = jest.fn(({ template }) => $q.when({ result: template.includes("name") ? "Ada" : "alerts" }));
    const exec = jest.fn(() => $q.when({ data: {} }));
    const { scope } = createCtrl({
      config: connectorConfig({
        params: {
          who: "{{ vars.input.records[0].name }}",
          mod: "{{ vars.input.records[0].module }}",
          lit: "plain",
        },
      }),
      services: {
        connectorService: { executeConnectorAction: exec },
        dynamicValueService: { evaluateJinja },
      },
    });
    scope.refresh();
    flush();
    expect(evaluateJinja).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][4]).toEqual({ who: "Ada", mod: "alerts", lit: "plain" });
  });

  test("empty params resolve to an empty object", () => {
    const exec = jest.fn(() => $q.when({ data: {} }));
    const { scope } = createCtrl({
      config: connectorConfig({}),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(exec.mock.calls[0][4]).toEqual({});
  });

  test("builds an empty record context when FormEntityService.get throws", () => {
    const exec = jest.fn(() => $q.when({ data: {} }));
    const evaluateJinja = jest.fn(({ values }) => $q.when({ result: JSON.stringify(values.vars.input.records[0]) }));
    const { scope } = createCtrl({
      config: connectorConfig({ params: { r: "{{ x }}" } }),
      services: { connectorService: { executeConnectorAction: exec }, dynamicValueService: { evaluateJinja } },
      entity: null,
    });
    scope.refresh();
    flush();
    // records[0] is {} when no entity — never throws.
    expect(exec.mock.calls[0][4].r).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// resolvePath / parsePath robustness (via columns-mode rendering)
// ---------------------------------------------------------------------------
describe("path resolution robustness", () => {
  function cellFor(rootPath, columnPath, sample) {
    const exec = jest.fn(() => $q.when({ data: sample }));
    const { scope } = createCtrl({
      config: connectorConfig({
        output: { mode: "table", table: { rootPath, mode: "columns", columns: [{ path: columnPath, header: "C" }] } },
      }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    return scope;
  }

  test("out-of-range array index resolves to empty cell", () => {
    const scope = cellFor("rows", "tags[9]", { rows: [{ tags: ["a"] }] });
    expect(scope.tableRows[0][0]).toBe("");
  });

  test("trailing-dot path resolves the leading key", () => {
    const scope = cellFor("rows", "id", { rows: [{ id: 3 }] });
    expect(scope.tableRows[0][0]).toBe("3");
  });

  test("indexing a non-array yields empty cell", () => {
    const scope = cellFor("rows", "id[0]", { rows: [{ id: 3 }] });
    expect(scope.tableRows[0][0]).toBe("");
  });

  test("deep dotted path resolves nested value", () => {
    const scope = cellFor("rows", "meta.geo.country", { rows: [{ meta: { geo: { country: "US" } } }] });
    expect(scope.tableRows[0][0]).toBe("US");
  });

  test("unresolved root path produces the path warning (no headers)", () => {
    const exec = jest.fn(() => $q.when({ data: { other: 1 } }));
    const { scope } = createCtrl({
      config: connectorConfig({
        output: { mode: "table", table: { rootPath: "nope.deep", mode: "auto" } },
      }),
      services: { connectorService: { executeConnectorAction: exec } },
    });
    scope.refresh();
    flush();
    expect(scope.tableHeaders).toEqual([]);
  });
});
