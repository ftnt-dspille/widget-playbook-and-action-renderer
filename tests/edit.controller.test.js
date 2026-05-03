"use strict";
// edit.controller tests — jsdom project (see jest.config.js).
// Mirrors the jinja-editor test bootstrapping: stub jasmine global, require
// angular + angular-mocks, register a fresh cybersponse module, then load the
// controller IIFE which registers itself against that module.

global.jasmine = global.jasmine || {};

require("angular");
require("angular-mocks");

angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/edit.controller.js");

const CTRL_NAME = "editActionRendererWidget100DevCtrl";

const ng = window.angular; // eslint-disable-line no-undef
const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

let $rootScope, $controller, $q, $timeout;

function makeService(impl) { return Object.assign({}, impl); }

beforeEach(() => {
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", {});
    $provide.value("$state", { current: { name: "main.dashboard" }, params: {} });
    $provide.value("$uibModalInstance", {
      close: jest.fn(),
      dismiss: jest.fn(),
    });
    $provide.value("API", {
      ACTION_TRIGGER: "api/triggers/1/action/",
    });
    $provide.factory("toaster", () => ({
      success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn(),
    }));
    $provide.factory("connectorService", (_$q_) => ({
      loadConnectors: jest.fn(() => _$q_.when({ data: [] })),
      getConnector: jest.fn(() => _$q_.when({ operations: [], configurations: [] })),
      executeConnectorAction: jest.fn(() => _$q_.when({ data: {} })),
    }));
    $provide.factory("playbookService", (_$q_) => ({
      getActionPlaybooks: jest.fn(() => _$q_.when([])),
      getTriggerStep: jest.fn((pb) => pb && pb.steps && pb.steps[0]),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => _$q_.when({ result: null })),
    }));
    $provide.factory("FormEntityService", () => ({
      get: jest.fn(() => null),
    }));
    $provide.factory("dynamicValueService", (_$q_) => ({
      evaluateJinja: jest.fn(({ template }) =>
        _$q_.when({ result: "RESOLVED:" + template })
      ),
    }));
    $provide.factory("$resource", (_$q_) => () => ({
      save: jest.fn(() => ({ $promise: _$q_.when({}) })),
    }));
    // Stub lodash — the edit controller injects `_` but the paths exercised
    // here (source picker, params, table-shaping, modal lifecycle) don't call
    // any lodash methods, so an empty object is enough.
    $provide.value("_", {});
  });

  ngInject((_$rootScope_, _$controller_, _$q_, _$timeout_) => {
    $rootScope = _$rootScope_;
    $controller = _$controller_;
    $q = _$q_;
    $timeout = _$timeout_;
  });
});

// The controllers grab connectorService and playbookService via
// $injector.get(...) so missing-provider chains (websocketService -> $stomp)
// don't kill the controller in the dev harness. Tests fake $injector with a
// service map so each test can supply custom implementations.
function createCtrl({ config = {}, services = {}, state = {} } = {}) {
  const scope = $rootScope.$new();
  // Default mock for connectorService — covers every method the controller
  // calls, including getAgents (added when the agent-aware execution path
  // landed). Per-test overrides are merged onto this so individual tests
  // only stub what they care about.
  const defaultConnectorService = {
    loadConnectors: jest.fn(() => $q.when({ data: [] })),
    getConnector: jest.fn(() => $q.when({ operations: [], configurations: [] })),
    executeConnectorAction: jest.fn(() => $q.when({ data: {} })),
    getAgents: jest.fn(() => $q.when([])),
  };
  const fakeInjectorMap = {
    connectorService: Object.assign({}, defaultConnectorService, services.connectorService || {}),
    playbookService: services.playbookService || {
      getActionPlaybooks: jest.fn(() => $q.when([])),
      getTriggerStep: jest.fn((pb) => pb && pb.steps && pb.steps[0]),
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
  const overrides = {
    $scope: scope,
    config,
    $state: Object.assign({ current: { name: "main.dashboard" }, params: {} }, state),
    $injector,
  };
  // Pass-through any other overridden services as locals.
  for (const k of Object.keys(services)) {
    if (k === "connectorService" || k === "playbookService") continue;
    overrides[k] = services[k];
  }
  $controller(CTRL_NAME, overrides);
  $rootScope.$apply();
  return { scope, ...services };
}

// ---------------------------------------------------------------------------

describe("edit controller — initialization", () => {
  test("applies config defaults when none provided", () => {
    const { scope } = createCtrl();
    expect(scope.config.source.kind).toBe("connector");
    expect(scope.config.params).toEqual({});
    expect(scope.config.output.mode).toBe("raw");
    expect(scope.config.output.table.mode).toBe("auto");
    expect(scope.activeStep).toBe(1);
  });

  test("preserves saved selection when reopened", () => {
    const saved = {
      title: "My Widget",
      source: { kind: "playbook", uuid: "abc", iri: "/api/3/workflows/abc", name: "Greet" },
      params: { hello: "world" },
      output: { mode: "jinja", table: { rootPath: "data", mode: "auto", columns: [] }, jinjaTemplate: "Hi" },
    };
    const { scope } = createCtrl({ config: saved });
    expect(scope.config.title).toBe("My Widget");
    expect(scope.config.source.kind).toBe("playbook");
    expect(scope.config.params).toEqual({ hello: "world" });
    expect(scope.config.output.mode).toBe("jinja");
    expect(scope.config.output.jinjaTemplate).toBe("Hi");
  });

  test("loads connector list on init when kind=connector", () => {
    let calls = 0;
    const connectorService = {
      loadConnectors: jest.fn(() => { calls++; return $q.when({ data: [{ name: "c1", version: "1.0", label: "C1" }] }); }),
      getConnector: jest.fn(() => $q.when({ operations: [], configurations: [] })),
      executeConnectorAction: jest.fn(() => $q.when({ data: {} })),
    };
    const { scope } = createCtrl({ services: { connectorService } });
    expect(calls).toBeGreaterThan(0);
    expect(scope.connectors.length).toBe(1);
  });

  test("loads playbook list on init when kind=playbook", () => {
    const pb = { uuid: "u1", "@id": "/api/3/workflows/u1", name: "Run X", steps: [{ arguments: { route: "r/1" } }] };
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([pb])),
      getTriggerStep: jest.fn(() => pb.steps[0]),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const FormEntityService = { get: jest.fn(() => ({ module: "alerts", name: "alerts" })) };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService, FormEntityService },
    });
    expect(scope.playbooks).toEqual([pb]);
  });
});

// ---------------------------------------------------------------------------

describe("source switching", () => {
  test("onKindChange resets params and lazy-loads playbooks", () => {
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([{ uuid: "x", "@id": "/api/3/workflows/x", steps: [{ arguments: {} }] }])),
      getTriggerStep: jest.fn((pb) => pb.steps[0]),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const FormEntityService = { get: jest.fn(() => ({ module: "alerts" })) };
    const { scope } = createCtrl({ services: { playbookService, FormEntityService } });
    scope.config.params = { foo: "bar" };
    scope.config.source.kind = "playbook";
    scope.onKindChange();
    $rootScope.$apply();
    expect(scope.config.params).toEqual({});
    expect(playbookService.getActionPlaybooks).toHaveBeenCalled();
    expect(scope.playbooks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("connector flow", () => {
  test("onConnectorPicked sets source and fetches connector details", () => {
    const details = {
      operations: [{ operation: "get_x", title: "Get X", parameters: [{ name: "id", type: "text" }], visible: true }],
      configurations: [{ config_id: "cfg-1", name: "Default" }],
    };
    const connectorService = {
      loadConnectors: jest.fn(() => $q.when({ data: [] })),
      getConnector: jest.fn(() => $q.when(details)),
      executeConnectorAction: jest.fn(() => $q.when({ data: {} })),
    };
    const { scope } = createCtrl({ services: { connectorService } });
    scope.picks.connectorPicked = { name: "fortios", version: "2.0.0", label: "FortiOS" };
    scope.onConnectorPicked();
    $rootScope.$apply();
    expect(scope.config.source.name).toBe("fortios");
    expect(scope.config.source.version).toBe("2.0.0");
    expect(scope.connectorDetails).toBe(details);
    // Single configuration auto-selected.
    expect(scope.config.source.config).toBe("cfg-1");
  });

  test("onOperationPicked rebuilds connector param fields from operation parameters", () => {
    const { scope } = createCtrl();
    scope.connectorDetails = {
      operations: [{ operation: "search", title: "Search", parameters: [
        { name: "query", title: "Query", type: "text", required: true },
        { name: "limit", title: "Limit", type: "integer" },
      ], visible: true }],
      configurations: [],
    };
    scope.picks.operationPicked = scope.connectorDetails.operations[0];
    scope.onOperationPicked();
    expect(scope.config.source.operation).toBe("search");
    // For connector sources the rendered form lives in connectorParamFields
    // (cs-connector-field-renderer pipeline) rather than the legacy
    // paramRows. paramRows stays empty for connectors and is only used for
    // playbook input variables.
    expect(scope.paramRows.length).toBe(0);
    expect(scope.connectorParamFields.length).toBe(2);
    expect(scope.connectorParamFields[0]).toMatchObject({ name: "query", required: true });
    expect(scope.connectorParamFields[1]).toMatchObject({ name: "limit", type: "integer" });
  });

  test("operation with is_config_required=false sets configRequired flag", () => {
    const { scope } = createCtrl();
    scope.picks.operationPicked = { operation: "ping", title: "Ping", parameters: [], is_config_required: false };
    scope.onOperationPicked();
    expect(scope.config.source.configRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("playbook flow", () => {
  test("onPlaybookPicked extracts inputVariables and route", () => {
    const pb = {
      uuid: "u1",
      "@id": "/api/3/workflows/u1",
      name: "Greet",
      steps: [{
        arguments: {
          title: "Greet User",
          route: "abc-123",
          singleRecordExecution: true,
          inputVariables: [
            { name: "name", type: "text", label: "Name" },
            { name: "loud", type: "boolean" },
          ],
        },
      }],
    };
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([pb])),
      getTriggerStep: jest.fn(() => pb.steps[0]),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService },
    });
    scope.picks.playbookPicked = pb;
    scope.onPlaybookPicked();
    expect(scope.config.source.uuid).toBe("u1");
    expect(scope.config.source.route).toBe("abc-123");
    expect(scope.config.source.singleRecordExecution).toBe(true);
    expect(scope.config.source.inputVariables.length).toBe(2);
    expect(scope.paramRows.length).toBe(2);
    expect(scope.paramRows[0].title).toBe("Name");
  });
});

// ---------------------------------------------------------------------------

describe("Jinja resolution against entity", () => {
  test("previewParams calls evaluateJinja only for values containing {{ }}", () => {
    const evaluateJinja = jest.fn(({ template }) => $q.when({ result: "X(" + template + ")" }));
    const FormEntityService = { get: jest.fn(() => ({ originalData: { name: "Ada" } })) };
    const { scope } = createCtrl({
      services: { dynamicValueService: { evaluateJinja }, FormEntityService },
    });
    scope.config.params = {
      literal: "static-value",
      templated: "{{ vars.input.records[0].name }}",
      number: 42,
    };
    scope.previewParams();
    $rootScope.$apply();
    expect(evaluateJinja).toHaveBeenCalledTimes(1);
    expect(evaluateJinja).toHaveBeenCalledWith({
      template: "{{ vars.input.records[0].name }}",
      values: { vars: { input: { records: [{ name: "Ada" }] } } },
    });
    expect(scope.resolvePreview).toEqual({
      literal: "static-value",
      templated: "X({{ vars.input.records[0].name }})",
      number: 42,
    });
  });
});

// ---------------------------------------------------------------------------

describe("execute (run with current record)", () => {
  test("connector path resolves params then calls executeConnectorAction", () => {
    const evaluateJinja = jest.fn(({ template }) => $q.when({ result: "Ada" }));
    const executeConnectorAction = jest.fn(() => $q.when({ data: { hits: [{ id: 1 }] } }));
    const FormEntityService = { get: jest.fn(() => ({ originalData: { name: "Ada" } })) };
    const { scope } = createCtrl({
      config: { source: { kind: "connector", name: "c", version: "1", operation: "search", config: "cfg" } },
      services: {
        dynamicValueService: { evaluateJinja },
        FormEntityService,
        connectorService: {
          loadConnectors: jest.fn(() => $q.when({ data: [] })),
          getConnector: jest.fn(() => $q.when({ operations: [], configurations: [] })),
          executeConnectorAction,
        },
      },
    });
    scope.config.params = { name: "{{ vars.input.records[0].name }}" };
    scope.runWithCurrentRecord();
    $rootScope.$apply();
    expect(executeConnectorAction).toHaveBeenCalledWith(
      "c", "1", "search", "cfg",
      { name: "Ada" },
      true, {}, undefined
    );
    expect(scope.executedSample).toEqual({ hits: [{ id: 1 }] });
    expect(scope.executing).toBe(false);
  });

  test("connector path surfaces server error message", () => {
    const executeConnectorAction = jest.fn(() => $q.reject({ data: { message: "boom" } }));
    const { scope, toaster } = (() => {
      const toaster = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
      const r = createCtrl({
        config: { source: { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" } },
        services: {
          toaster,
          connectorService: {
            loadConnectors: jest.fn(() => $q.when({ data: [] })),
            getConnector: jest.fn(() => $q.when({})),
            executeConnectorAction,
          },
        },
      });
      return { scope: r.scope, toaster };
    })();
    scope.runWithCurrentRecord();
    $rootScope.$apply();
    expect(scope.lastExecutionError).toBe("boom");
    expect(toaster.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("table-shaping helpers", () => {
  test("resolvePath supports dotted and bracket notation", () => {
    const { scope } = createCtrl();
    const obj = { data: { hits: [{ id: 1 }, { id: 2 }] }, top: "x" };
    expect(scope.resolvePath(obj, "top")).toEqual({ found: true, value: "x" });
    expect(scope.resolvePath(obj, "data.hits")).toEqual({ found: true, value: obj.data.hits });
    expect(scope.resolvePath(obj, "data.hits[1].id")).toEqual({ found: true, value: 2 });
    expect(scope.resolvePath(obj, "data.missing")).toEqual({ found: false });
    expect(scope.resolvePath(obj, "data.hits[5]")).toEqual({ found: false });
    expect(scope.resolvePath(obj, "")).toEqual({ found: true, value: obj });
  });

  test("tablePathStatus reports array vs object vs missing", () => {
    const { scope } = createCtrl();
    scope.executedSample = { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }], one: { x: 1 }, lit: "hi" };
    scope.config.output.table.rootPath = "rows";
    let s = scope.tablePathStatus();
    expect(s.kind).toBe("array");
    expect(s.count).toBe(2);
    expect(s.sampleKeys).toEqual(["a", "b"]);
    scope.config.output.table.rootPath = "one";
    s = scope.tablePathStatus();
    expect(s.kind).toBe("object");
    expect(s.keys).toEqual(["x"]);
    scope.config.output.table.rootPath = "lit";
    expect(scope.tablePathStatus().kind).toBe("primitive");
    scope.config.output.table.rootPath = "nope.nope";
    expect(scope.tablePathStatus().kind).toBe("missing");
  });

  test("tablePathStatus returns no-sample before execution", () => {
    const { scope } = createCtrl();
    scope.executedSample = null;
    expect(scope.tablePathStatus().kind).toBe("no-sample");
  });

  test("addColumn / removeColumn mutate config.output.table.columns", () => {
    const { scope } = createCtrl();
    expect(scope.config.output.table.columns).toEqual([]);
    scope.addColumn();
    scope.addColumn();
    expect(scope.config.output.table.columns.length).toBe(2);
    scope.removeColumn(0);
    expect(scope.config.output.table.columns.length).toBe(1);
  });

  test("autoFillColumns derives columns from row union of keys", () => {
    const { scope } = createCtrl();
    scope.executedSample = {
      hits: [
        { name: "a", score: 10 },
        { name: "b", score: 7, severity: "high" },
        { name: "c", tags: ["x"] },
      ],
    };
    scope.config.output.table.rootPath = "hits";
    scope.autoFillColumns();
    const paths = scope.config.output.table.columns.map((c) => c.path).sort();
    expect(paths).toEqual(["name", "score", "severity", "tags"]);
  });

  test("autoFillColumns is a no-op when path doesn't resolve to an array", () => {
    const { scope } = createCtrl();
    scope.executedSample = { meta: { count: 3 } };
    scope.config.output.table.rootPath = "meta";
    scope.autoFillColumns();
    expect(scope.config.output.table.columns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("modal lifecycle", () => {
  test("save closes modal with config payload", () => {
    const $uibModalInstance = { close: jest.fn(), dismiss: jest.fn() };
    const { scope } = createCtrl({ services: { $uibModalInstance } });
    scope.config.title = "Saved";
    // The 4-step wizard's canSave() gates on per-step `canAdvance` (Source,
    // Params, Run sample, Output). Stub it so the test focuses on the
    // close-with-payload contract rather than re-asserting the wizard
    // gating logic (covered separately).
    scope.canSave = function () { return true; };
    scope.save();
    expect($uibModalInstance.close).toHaveBeenCalledWith(scope.config);
  });

  test("cancel dismisses modal", () => {
    const $uibModalInstance = { close: jest.fn(), dismiss: jest.fn() };
    const { scope } = createCtrl({ services: { $uibModalInstance } });
    scope.cancel();
    expect($uibModalInstance.dismiss).toHaveBeenCalledWith("cancel");
  });
});

// ---------------------------------------------------------------------------

describe("step navigation gating", () => {
  test("canAdvance(1) requires complete connector selection", () => {
    const { scope } = createCtrl();
    expect(scope.canAdvance(1)).toBe(false);
    scope.config.source = { kind: "connector", name: "c", version: "1", operation: "x", config: "cfg" };
    expect(scope.canAdvance(1)).toBe(true);
    // Operation that doesn't require config still passes.
    scope.config.source = { kind: "connector", name: "c", version: "1", operation: "x", configRequired: false };
    expect(scope.canAdvance(1)).toBe(true);
  });

  test("canAdvance(1) requires playbook selection", () => {
    const { scope } = createCtrl({ config: { source: { kind: "playbook" } } });
    expect(scope.canAdvance(1)).toBe(false);
    scope.config.source.uuid = "u1";
    scope.config.source.iri = "/api/3/workflows/u1";
    expect(scope.canAdvance(1)).toBe(true);
  });
});
