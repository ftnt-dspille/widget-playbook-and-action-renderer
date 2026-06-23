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

const CTRL_NAME = "editActionRendererWidget105DevCtrl";

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
      // loadAllPlaybooks (dashboard branch) uses .get; default to an empty
      // hydra collection so controller bootstrap doesn't blow up in tests
      // that don't override the playbook listing.
      get: jest.fn(() => ({ $promise: _$q_.when({ "hydra:member": [] }) })),
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
    // decorateForDropdown returns lean plain objects (same path for module-
    // scoped and "all" lists) carrying the picker fields.
    expect(scope.playbooks).toEqual([
      {
        uuid: "u1",
        "@id": "/api/3/workflows/u1",
        name: "Run X",
        steps: pb.steps,
        actionTriggerName: "Run X",
        collectionName: "",
      },
    ]);
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

  test("onPlaybookPicked derives the trigger from steps when playbookService has no getTriggerStep", () => {
    // Mirrors the live "Show all" environment: playbookService either isn't
    // registered or doesn't expose getTriggerStep (it transitively needs
    // websocket/$stomp). The pick must still populate config.source from the
    // playbook's own decorated steps rather than no-oping.
    const pb = {
      uuid: "u9",
      "@id": "/api/3/workflows/u9",
      name: "Enrich Indicator",
      steps: [{
        arguments: {
          title: "Enrich Indicator",
          route: "enrich/9",
          singleRecordExecution: false,
          inputVariables: [{ name: "indicator", type: "text", label: "Indicator" }],
        },
      }],
    };
    // No getTriggerStep on this service → forces the step-derived fallback.
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([pb])),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService },
    });
    scope.picks.playbookPicked = pb;
    scope.onPlaybookPicked();
    expect(scope.config.source.kind).toBe("playbook");
    expect(scope.config.source.uuid).toBe("u9");
    expect(scope.config.source.route).toBe("enrich/9");
    expect(scope.config.source.singleRecordExecution).toBe(false);
    expect(scope.config.source.inputVariables.length).toBe(1);
    expect(scope.paramRows.length).toBe(1);
    expect(scope.paramRows[0].name).toBe("indicator");
  });

  test("onPlaybookPicked finds the trigger step even when it is not steps[0]", () => {
    // A multi-step action playbook: the trigger (carrying route/inputVariables)
    // may not be the first step. The fallback scans for the step with
    // arguments.route / inputVariables before defaulting to steps[0].
    const pb = {
      uuid: "u10",
      "@id": "/api/3/workflows/u10",
      name: "Multi Step",
      steps: [
        { arguments: { name: "Set Vars" } },
        { arguments: { title: "Trigger", route: "multi/10", inputVariables: [{ name: "ip", type: "text" }] } },
      ],
    };
    const playbookService = { getActionPlaybooks: jest.fn(() => $q.when([pb])) };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService },
    });
    scope.picks.playbookPicked = pb;
    scope.onPlaybookPicked();
    expect(scope.config.source.route).toBe("multi/10");
    expect(scope.config.source.inputVariables.length).toBe(1);
    expect(scope.config.source.inputVariables[0].name).toBe("ip");
  });

  test("playbook required input variables gate step 2 (read from config.params, seed defaultValue)", () => {
    const pb = {
      uuid: "u11",
      "@id": "/api/3/workflows/u11",
      name: "Block Domain",
      steps: [{
        arguments: {
          title: "Block Domain",
          route: "block/11",
          inputVariables: [
            { name: "domain", type: "string", label: "Domain", required: true },
            { name: "reason", type: "string", label: "Reason", required: false, defaultValue: "Malicious" },
          ],
        },
      }],
    };
    const playbookService = { getActionPlaybooks: jest.fn(() => $q.when([pb])) };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService },
    });
    scope.picks.playbookPicked = pb;
    scope.onPlaybookPicked();
    // required flag propagates to the row; defaultValue seeds config.params.
    const domainRow = scope.paramRows.find((r) => r.name === "domain");
    expect(domainRow.required).toBe(true);
    expect(scope.config.params.reason).toBe("Malicious");
    // required-but-empty 'domain' must block advancing past step 2.
    expect(scope.canAdvance(2)).toBe(false);
    scope.config.params.domain = "evil.example";
    expect(scope.canAdvance(2)).toBe(true);
  });

  test("onPlaybookPicked tags an action-trigger playbook triggerType=action", () => {
    const pb = {
      uuid: "ua", "@id": "/api/3/workflows/ua", name: "Action PB",
      steps: [{ arguments: { title: "Act", route: "act/1" } }],
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService: { getActionPlaybooks: jest.fn(() => $q.when([pb])) } },
    });
    scope.picks.playbookPicked = pb;
    scope.onPlaybookPicked();
    expect(scope.config.source.triggerType).toBe("action");
    expect(scope.config.source.route).toBe("act/1");
  });

  test("onPlaybookPicked tags a generic/manual Start-trigger playbook triggerType=manual (no route)", () => {
    // Mirrors "query critical": a Start trigger with triggerOnSource and NO
    // action route → must be fired via /api/triggers/1/notrigger/<uuid>.
    const pb = {
      uuid: "9ce6f46f", "@id": "/api/3/workflows/9ce6f46f", name: "query critical",
      steps: [{
        name: "Start",
        arguments: { __triggerLimit: null, triggerOnSource: true, triggerOnReplicate: false },
      }],
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService: { getActionPlaybooks: jest.fn(() => $q.when([pb])) } },
    });
    scope.picks.playbookPicked = pb;
    scope.onPlaybookPicked();
    expect(scope.config.source.triggerType).toBe("manual");
    expect(scope.config.source.route).toBeUndefined();
    expect(scope.config.source.uuid).toBe("9ce6f46f");
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

  test("resolvePath auto-descends a single-element wrapper array on a key path", () => {
    const { scope } = createCtrl();
    // Mirrors the live FortiGate shape: result is a 1-element array wrapping the
    // payload. "result.data" should reach into the lone element (no explicit [0]).
    const obj = { data: { gui_response: { result: [{ data: [{ name: "root" }, { name: "test" }] }] } } };
    const r = scope.resolvePath(obj, "data.gui_response.result.data");
    expect(r.found).toBe(true);
    expect(r.value).toEqual([{ name: "root" }, { name: "test" }]);
    // The explicit-index form still works and is equivalent.
    expect(scope.resolvePath(obj, "data.gui_response.result[0].data")).toEqual(r);
    // A MULTI-element array is ambiguous → not auto-descended on a key path.
    const multi = { rows: [{ a: 1 }, { a: 2 }] };
    expect(scope.resolvePath(multi, "rows.a")).toEqual({ found: false });
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

describe("dashboard playbook listing", () => {
  // On a dashboard there is no FormEntity record and no $state module param.
  // The legacy `loadPlaybookList` would early-return with an empty list and
  // the user could never pick a playbook. Verify the controller flips into
  // dashboard mode and uses the all-playbooks $resource path instead.
  test("isDashboardContext=true forces showAllPlaybooks and lists ALL active playbooks via POST /api/query/workflows", () => {
    // __selectFields trims the response to uuid+name only — no step bodies — so
    // the dropdown payload is a fraction of the full GET /api/3/workflows dump.
    const allList = [
      { uuid: "p1", "@id": "/api/3/workflows/p1", name: "PB1" },
      { uuid: "p2", "@id": "/api/3/workflows/p2", name: "PB2" },
    ];
    let savedBody = null;
    const resourceSave = jest.fn((body) => { savedBody = body; return { $promise: $q.when({ "hydra:member": allList }) }; });
    const $resourceFactory = jest.fn(() => ({ save: resourceSave }));
    const playbookService = {
      // Should NOT be called when in dashboard mode — getActionPlaybooks
      // requires entity.module which we don't have.
      getActionPlaybooks: jest.fn(() => $q.when([])),
      getTriggerStep: jest.fn((pb) => pb && pb.steps && pb.steps[0]),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const FormEntityService = { get: jest.fn(() => null) };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService, FormEntityService, $resource: $resourceFactory },
      state: { params: {} },
    });
    expect(scope.isDashboardContext).toBe(true);
    expect(scope.showAllPlaybooks).toBe(true);
    expect(playbookService.getActionPlaybooks).not.toHaveBeenCalled();
    // The request POSTs to the query endpoint with $limit baked into the URL
    // ($-params are dropped by Angular's serializer) and lists generic playbooks
    // too (not just /api/workflows/actions record-context triggers). The picked
    // playbook's trigger step is fetched on select.
    const calledUrl = $resourceFactory.mock.calls[0][0];
    expect(calledUrl).toContain("/api/query/workflows");
    expect(calledUrl).toContain("$limit=1000");
    expect(calledUrl).not.toContain("/api/workflows/actions");
    // Body trims columns via __selectFields and gates the isActive filter with
    // an explicit logic:"AND" (filters are silently dropped without it).
    expect(savedBody.logic).toBe("AND");
    expect(savedBody.__selectFields).toEqual(["uuid", "name"]);
    expect(savedBody.filters).toEqual([{ field: "isActive", operator: "eq", value: true }]);
    expect(scope.playbooks.length).toBe(2);
    // Without step bodies, actionTriggerName falls back to the playbook name and
    // collectionName is empty — full fidelity is restored on select.
    expect(scope.playbooks[0]).toEqual({
      uuid: "p1",
      "@id": "/api/3/workflows/p1",
      name: "PB1",
      steps: undefined,
      actionTriggerName: "PB1",
      collectionName: "",
    });
  });

  test("loadAllPlaybooks reads alternate response envelopes and warns when empty", () => {
    // res.data shape (some proxies unwrap hydra), then an empty result.
    const resourceSave = jest.fn(() => ({ $promise: $q.when({ data: [] }) }));
    const $resourceFactory = jest.fn(() => ({ save: resourceSave }));
    const toaster = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([])),
      getTriggerStep: jest.fn(),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService, FormEntityService: { get: () => null }, $resource: $resourceFactory, toaster },
      state: { params: {} },
    });
    expect(scope.playbooks).toEqual([]);
    expect(toaster.warning).toHaveBeenCalled();
  });

  test("reconstructs @id from uuid when __selectFields omits it", () => {
    // The trimmed query response carries uuid+name but no @id; the picker needs
    // an IRI (source.iri) so decorateForDropdown rebuilds it deterministically.
    const list = [{ uuid: "abc123", name: "No IRI PB" }];
    const resourceSave = jest.fn(() => ({ $promise: $q.when({ "hydra:member": list }) }));
    const $resourceFactory = jest.fn(() => ({ save: resourceSave }));
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([])),
      getTriggerStep: jest.fn(),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService, FormEntityService: { get: () => null }, $resource: $resourceFactory },
      state: { params: {} },
    });
    expect(scope.playbooks[0]["@id"]).toBe("/api/3/workflows/abc123");
  });

  test("record context (entity.module present) leaves dashboard flag false", () => {
    const FormEntityService = { get: jest.fn(() => ({ module: "alerts" })) };
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([])),
      getTriggerStep: jest.fn(),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService, FormEntityService },
    });
    expect(scope.isDashboardContext).toBe(false);
    expect(scope.showAllPlaybooks).toBe(false);
    expect(playbookService.getActionPlaybooks).toHaveBeenCalled();
  });

  test("$state.params.module also counts as record context", () => {
    const FormEntityService = { get: jest.fn(() => null) };
    const playbookService = {
      getActionPlaybooks: jest.fn(() => $q.when([])),
      getTriggerStep: jest.fn(),
      checkPlaybookExecutionCompletion: jest.fn(),
      getExecutedPlaybookLogData: jest.fn(() => $q.when({ result: null })),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "playbook" } },
      services: { playbookService, FormEntityService },
      state: { params: { module: "incidents" } },
    });
    expect(scope.isDashboardContext).toBe(false);
    expect(playbookService.getActionPlaybooks).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Customer-reported fixes: config persistence + renderer stability.
// ---------------------------------------------------------------------------

describe("connector param persistence (config-loss safety net)", () => {
  test("syncParamsFromConnectorFields copies live field values into config.params", () => {
    const { scope } = createCtrl({
      config: { source: { kind: "connector", name: "c", version: "1", operation: "op", config: "cfg" } },
    });
    scope.connectorParamFields = [
      { name: "ip", value: "1.2.3.4" },
      { name: "hidden", value: "x", visible: false }, // excluded
      {
        name: "mode",
        value: "policy",
        onchange: { policy: [{ name: "policy_name", value: "blocklist" }] },
      },
      { name: "wrap", parameters: [{ name: "nested", value: "deep" }] },
    ];
    scope.config.params = {};
    scope.syncParamsFromConnectorFields();
    expect(scope.config.params.ip).toBe("1.2.3.4");
    expect(scope.config.params.mode).toBe("policy");
    expect(scope.config.params.policy_name).toBe("blocklist");
    expect(scope.config.params.nested).toBe("deep");
    expect(scope.config.params.hidden).toBeUndefined();
  });

  test("save() syncs field values into config.params before closing", () => {
    const close = jest.fn();
    const { scope } = createCtrl({
      config: {
        source: { kind: "connector", name: "c", version: "1", operation: "op", config: "cfg" },
      },
      services: { $uibModalInstance: { close, dismiss: jest.fn() } },
    });
    // Reach Output step so canSave() passes.
    scope.gotoStep(4);
    scope.connectorParamFields = [{ name: "ip", value: "9.9.9.9", required: true }];
    scope.config.params = {};
    scope.save();
    expect(close).toHaveBeenCalled();
    expect(close.mock.calls[0][0].params.ip).toBe("9.9.9.9");
  });
});

describe("connectorDataForRenderer identity stability (anti-flash)", () => {
  test("changing only the configuration keeps the renderer-data reference stable", () => {
    const details = { operations: [{ operation: "op", title: "Op", parameters: [] }], configuration: [
      { config_id: "a", name: "A" }, { config_id: "b", name: "B" },
    ] };
    const connectorService = {
      loadConnectors: jest.fn(() => $q.when({ data: [] })),
      getConnector: jest.fn(() => $q.when(details)),
      executeConnectorAction: jest.fn(() => $q.when({ data: {} })),
      getAgents: jest.fn(() => $q.when([])),
    };
    const { scope } = createCtrl({
      config: { source: { kind: "connector", name: "c", version: "1", operation: "op", config: "a" } },
      services: { connectorService },
    });
    const first = scope.connectorDataForRenderer;
    expect(first).toBeTruthy();
    expect(first.config).toBe("a");
    // Switch configuration — reference must NOT change (no renderer teardown).
    scope.picks.configPicked = "b";
    scope.onConfigPicked();
    expect(scope.connectorDataForRenderer).toBe(first); // same object
    expect(scope.connectorDataForRenderer.config).toBe("b"); // updated in place
  });
});
