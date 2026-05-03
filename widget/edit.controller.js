/* Copyright start
   MIT License
   Copyright (c) 2026 Dylan Spille
   Copyright end */
"use strict";
(function () {
  angular
    .module("cybersponse")
    .controller(
      "editActionRendererWidget100DevCtrl",
      editActionRendererWidget100DevCtrl
    );

  // playbookService transitively depends on websocketService -> $stomp ->
  // $stompProvider, which the dev harness doesn't register. Injecting
  // playbookService directly would prevent the whole controller from
  // instantiating in the harness. We grab it lazily via $injector.get so
  // the connector path still works in the harness even when playbook
  // services are unavailable.
  editActionRendererWidget100DevCtrl.$inject = [
    "$scope",
    "$state",
    "$uibModalInstance",
    "config",
    "FormEntityService",
    "dynamicValueService",
    "toaster",
    "_",
    "$resource",
    "API",
    "$q",
    "$injector",
    "$timeout",
  ];

  function editActionRendererWidget100DevCtrl(
    $scope,
    $state,
    $uibModalInstance,
    config,
    FormEntityService,
    dynamicValueService,
    toaster,
    _,
    $resource,
    API,
    $q,
    $injector,
    $timeout
  ) {
    function lazyService(name) {
      try { return $injector.get(name); } catch (e) {
        try { console.warn("[actionRenderer] lazyService failed for " + name, e && (e.message || e)); } catch (_) {}
        return null;
      }
    }
    var connectorService = lazyService("connectorService");
    function getPlaybookService() {
      var s = lazyService("playbookService");
      if (!s) {
        toaster.warning({
          body:
            "Playbook source is unavailable in this environment (websocket/stomp services not registered). " +
            "Switch to a connector action.",
        });
      }
      return s;
    }
    // -------- Config defaults ----------------------------------------------
    $scope.config = angular.extend(
      {
        title: "Action Renderer",
        source: { kind: "connector" }, // 'connector' | 'playbook'
        params: {},
        agent: null,
        autoExecute: true,
        output: {
          mode: "raw", // 'raw' | 'table' | 'jinja'
          table: { rootPath: "", mode: "auto", columns: [], emptyMessage: "No rows" },
          jinjaTemplate: "",
        },
      },
      config || {}
    );
    if (!$scope.config.source) $scope.config.source = { kind: "connector" };
    if (!$scope.config.params) $scope.config.params = {};
    if (!$scope.config.output) {
      $scope.config.output = {
        mode: "raw",
        table: { rootPath: "", mode: "auto", columns: [] },
        jinjaTemplate: "",
      };
    }

    // -------- Wizard state -------------------------------------------------
    $scope.activeStep = 1;
    $scope.maxStepReached = 1;
    $scope.gotoStep = function (n) {
      $scope.activeStep = n;
      if (n > $scope.maxStepReached) $scope.maxStepReached = n;
    };
    $scope.canAdvance = canAdvance;
    $scope.canSave = function () {
      // Save closes the modal with the wizard config; refuse until each
      // step's gating condition is satisfied AND the user has actually
      // reached the Output step. Otherwise it's possible to land on Save
      // with empty required params or an unconfigured output.
      return canAdvance(1) && canAdvance(2) && canAdvance(3) && $scope.maxStepReached >= 4;
    };

    function canAdvance(step) {
      switch (step) {
        case 1:
          return !!sourceSelectionComplete();
        case 2:
          return requiredParamsFilled();
        case 3:
          return true; // sample optional
        default:
          return true;
      }
    }
    // A param is "filled" if it has a non-empty value (a literal or a Jinja
     // expression). We can't validate the resolved value here — Jinja is
     // evaluated at runtime — so just check presence. Walk visible onchange
     // children too: required nested fields shouldn't be skippable.
     function requiredParamsFilled() {
       var src = $scope.config.source;
       if (!src) return false;
       if (src.kind === "playbook") {
         return ($scope.paramRows || []).every(function (r) {
           return !r.required || (r.value !== undefined && r.value !== null && String(r.value).length > 0);
         });
       }
       if (src.kind !== "connector") return true;
       var ok = true;
       function walk(arr) {
         (arr || []).forEach(function (p) {
           if (!p || p.visible === false) return;
           if (p.required && p.editable !== false) {
             var v = p.value;
             if (v === undefined || v === null || (typeof v === "string" && v.length === 0) ||
                 (Array.isArray(v) && v.length === 0)) {
               ok = false;
             }
           }
           if (Array.isArray(p.parameters)) walk(p.parameters);
         });
       }
       walk($scope.connectorParamFields);
       return ok;
     }
    function sourceSelectionComplete() {
      var s = $scope.config.source;
      if (!s || !s.kind) return false;
      if (s.kind === "connector") {
        return s.name && s.version && s.operation && (s.config || s.configRequired === false);
      }
      if (s.kind === "playbook") {
        return s.uuid && s.iri;
      }
      return false;
    }

    // -------- Listings: connectors & playbooks ----------------------------
    // ng-if creates a child scope, so primitive bindings (connectorPicked,
    // operationPicked, configPicked, playbookPicked) get shadowed. Group them
    // on an object so dot-notation reaches the controller scope.
    $scope.picks = {};
    $scope.connectors = [];
    $scope.connectorDetails = null; // full connector with operations + configurations
    $scope.connectorLoading = false;
    $scope.connectorListLoading = false;
    $scope.playbooks = [];
    $scope.playbookListLoading = false;
    $scope.entity = null;

    function loadEntity() {
      try {
        $scope.entity = FormEntityService.get();
      } catch (e) {
        $scope.entity = null;
      }
    }

    function loadConnectorList() {
      if (!connectorService) {
        toaster.error({ body: "connectorService unavailable in this environment." });
        return;
      }
      $scope.connectorListLoading = true;
      connectorService
        .loadConnectors("Completed")
        .then(
          function (data) {
            $scope.connectors = (data && (data.data || data)) || [];
            $scope.connectorListLoading = false;
            // If a connector was previously chosen, refresh its details.
            var sel = $scope.config.source;
            if (sel && sel.kind === "connector" && sel.name && sel.version) {
              loadConnectorDetails(sel.name, sel.version, false);
            }
          },
          function () {
            $scope.connectorListLoading = false;
            toaster.error({ body: "Failed to load connectors." });
          }
        );
    }

    function loadPlaybookList() {
      var pb = getPlaybookService();
      if (!pb) { $scope.playbooks = []; return; }
      var entity = $scope.entity;
      if (!entity || !entity.module) {
        // Dashboard / non-record context: still allow listing by passing module via $state.
        var module = $state && $state.params && $state.params.module;
        if (!module) {
          $scope.playbooks = [];
          return;
        }
        entity = { module: module, name: module };
      }
      $scope.playbookListLoading = true;
      // Pass false so we list ALL action-trigger playbooks for the module
      // without applying displayConditions against the current record. The
      // user is binding the widget at design-time; filtering by the live
      // record's field values would hide playbooks that are perfectly valid
      // for other records of the same module.
      pb
        .getActionPlaybooks(entity, false)
        .then(
          function (list) {
            $scope.playbooks = list || [];
            $scope.playbookListLoading = false;
          },
          function () {
            $scope.playbookListLoading = false;
            toaster.error({ body: "Failed to load playbooks." });
          }
        );
    }

    $scope.onKindChange = function () {
      $scope.config.params = {};
      $scope.executedSample = null;
      $scope.lastExecutionError = null;
      if ($scope.config.source.kind === "connector" && $scope.connectors.length === 0) {
        loadConnectorList();
      } else if ($scope.config.source.kind === "playbook" && $scope.playbooks.length === 0) {
        loadPlaybookList();
      }
    };

    // -------- Connector selection -----------------------------------------
    $scope.onConnectorPicked = function () {
      var pick = $scope.picks.connectorPicked;
      if (!pick) return;
      $scope.config.source = {
        kind: "connector",
        name: pick.name,
        version: pick.version,
        label: pick.label,
        icon: pick.icon_small || pick.icon,
      };
      $scope.config.params = {};
      $scope.executedSample = null;
      loadConnectorDetails(pick.name, pick.version, true);
    };

    function loadConnectorDetails(name, version, resetParams) {
      if (!connectorService) return;
      $scope.connectorLoading = true;
      $scope.connectorDetails = null;
      connectorService.getConnector(name, version).then(
        function (details) {
          $scope.connectorLoading = false;
          $scope.connectorDetails = details;
          // Pre-select first config if only one and required. Real SOAR returns
          // `configuration` (singular) on getConnector; older code expected
          // `configurations`. Accept either to stay forward-compatible.
          var cfgs = (details && (details.configuration || details.configurations)) || [];
          if (cfgs.length === 1) {
            $scope.config.source.config = cfgs[0].config_id;
          }
          // Re-derive operation metadata from the live connector. The saved
          // config may have been written by an older widget version that
          // didn't persist `parameters`, or the SOAR widget store stripped
          // them — either way, refreshing from getConnector ensures the
          // params editor renders.
          var savedOp = $scope.config.source.operation;
          if (savedOp && details && details.operations) {
            var match = null;
            for (var i = 0; i < details.operations.length; i++) {
              if (details.operations[i].operation === savedOp) {
                match = details.operations[i];
                break;
              }
            }
            if (match) {
              $scope.config.source.operationTitle = match.title;
              $scope.config.source.parameters = match.parameters || [];
              $scope.config.source.configRequired =
                match.is_config_required === undefined || match.is_config_required === null
                  ? true
                  : !!match.is_config_required;
              $scope.picks.operationPicked = match;
              $scope.rebuildParamRows();
            }
          }
          refreshConnectorDataForRenderer();
          loadAgentsForConnector(name, version);
        },
        function () {
          $scope.connectorLoading = false;
          toaster.error({ body: "Failed to load connector " + name + " v" + version });
        }
      );
    }

    $scope.onOperationPicked = function () {
      var op = $scope.picks.operationPicked;
      if (!op) return;
      $scope.config.source.operation = op.operation;
      $scope.config.source.operationTitle = op.title;
      $scope.config.source.parameters = op.parameters || [];
      $scope.config.source.configRequired =
        op.is_config_required === undefined || op.is_config_required === null
          ? true
          : !!op.is_config_required;
      $scope.config.params = {};
      $scope.rebuildParamRows();
    };

    $scope.onConfigPicked = function () {
      $scope.config.source.config = $scope.picks.configPicked;
      refreshConnectorDataForRenderer();
    };

    // -------- Playbook selection ------------------------------------------
    $scope.onPlaybookPicked = function () {
      var pb = $scope.picks.playbookPicked;
      if (!pb) return;
      var pbSvc = getPlaybookService();
      if (!pbSvc) return;
      var trigger = pbSvc.getTriggerStep(pb);
      var inputVars = (trigger && trigger.arguments && trigger.arguments.inputVariables) || [];
      $scope.config.source = {
        kind: "playbook",
        uuid: pb.uuid,
        iri: pb["@id"],
        name: pb.name,
        title: (trigger && trigger.arguments && trigger.arguments.title) || pb.name,
        route: trigger && trigger.arguments && trigger.arguments.route,
        singleRecordExecution:
          trigger && trigger.arguments && trigger.arguments.singleRecordExecution,
        inputVariables: inputVars.map(function (v) {
          return { name: v.name, type: v.type, label: v.label || v.name };
        }),
      };
      $scope.config.params = {};
      $scope.rebuildParamRows();
    };

    // -------- Param rendering rows ----------------------------------------
    // For connector sources we hand the live operation parameter schema
    // (deep-cloned so the renderer can mutate it freely) to SOAR's own
    // cs-connector-field-renderer directive — that gives us picklists,
    // visibility conditions, onchange-driven sub-parameter loading, etc.
    // for free. paramRows is only used for playbook input-variable rows.
    $scope.paramRows = [];
    $scope.connectorParamFields = [];
    // Reference object for cs-connector-field-renderer's apiOnchange flow
    // (websocket subscriptions that load dynamic options + subfields).
    // Mirrors the shape SOAR's connector-step form passes.
    $scope.connectorDataForRenderer = null;
    $scope.agents = [];
    $scope.agentsLoading = false;
    function loadAgentsForConnector(name, version) {
      $scope.agents = [];
      if (!connectorService || !name || !version) return;
      $scope.agentsLoading = true;
      connectorService.getAgents({ name: name, version: version }, true).then(
        function (list) {
          $scope.agents = (list || []).filter(function (a) { return !a.isIncompatible; });
          $scope.agentsLoading = false;
        },
        function () {
          $scope.agents = [];
          $scope.agentsLoading = false;
        }
      );
    }
    function refreshConnectorDataForRenderer() {
      var src = $scope.config.source;
      if (!src || src.kind !== "connector" || !$scope.connectorDetails) {
        $scope.connectorDataForRenderer = null;
        return;
      }
      $scope.connectorDataForRenderer = {
        connector: src.name,
        version: src.version,
        config: src.config,
        configuration:
          ($scope.connectorDetails.configuration || $scope.connectorDetails.configurations || []),
      };
    }
    $scope.hasParams = function () {
      var src = $scope.config.source;
      if (!src) return false;
      if (src.kind === "connector") return $scope.connectorParamFields.length > 0;
      if (src.kind === "playbook") return $scope.paramRows.length > 0;
      return false;
    };
    // SOAR's cs-field text-input template includes a one-time bind on a
    // `placeholder` scope var. When the connector schema doesn't define one,
    // the literal text "{{ ::placeholder }}" leaks into the input. Seed a
    // sensible default so the placeholder is always a string.
    function seedParamForRenderer(p) {
      if (!p) return p;
      if (p.placeholder === undefined || p.placeholder === null || p.placeholder === "") {
        p.placeholder = p.description || ("Value or Jinja expression for " + p.name);
      }
      // input.html only renders the actual <input> when jinjaExpressionView
      // is true. Without this, text fields render as a click-to-edit jinja
      // tag span and look broken on first render. We force it on for non-
      // select types so the input is visible immediately.
      if (p.type !== "select" && p.type !== "multiselect" && p.type !== "checkbox" && p.type !== "picklist") {
        if (p.jinjaExpressionView === undefined) p.jinjaExpressionView = true;
      }
      // input.html template guards on field.value.includes('resolveVault'),
      // which throws TypeError when value is undefined. Default to "".
      if (p.value === undefined || p.value === null) p.value = "";
      return p;
    }

    $scope.rebuildParamRows = function () {
      var src = $scope.config.source;
      $scope.paramRows = [];
      $scope.connectorParamFields = [];
      if (src.kind === "connector") {
        var params = (src.parameters || []).map(function (p) {
          return seedParamForRenderer(angular.copy(p));
        });
        function seed(arr) {
          (arr || []).forEach(function (p) {
            if (Object.prototype.hasOwnProperty.call($scope.config.params || {}, p.name)) {
              p.value = $scope.config.params[p.name];
            }
            // Walk static onchange children too so subfield placeholders
            // are seeded before the renderer ever expands them.
            if (p.onchange && typeof p.onchange === "object") {
              Object.keys(p.onchange).forEach(function (k) {
                if (Array.isArray(p.onchange[k])) {
                  p.onchange[k].forEach(seedParamForRenderer);
                  seed(p.onchange[k]);
                }
              });
            }
          });
        }
        seed(params);
        $scope.connectorParamFields = params;
        // The cs-field directive's link cycle runs m() which resets
        // jinjaExpressionView based on value+jinjaDefaultView, overwriting
        // our pre-seed. For text-style fields with empty values it lands on
        // false → the read-only `.jinja-tag-view-container` thin bar shows
        // instead of an input. Re-force it true after digest so the input
        // is visible. (We can't pass jinjaDefaultView='edit' globally — that
        // flips selects to text-input mode via app.unmin.js:9868.)
        var TEXT_TYPES = { text:1, password:1, integer:1, number:1, json:1, "jinja.input":1 };
        function forceInputView(arr) {
          (arr || []).forEach(function (p) {
            if (p && TEXT_TYPES[p.type]) p.jinjaExpressionView = true;
            if (p && Array.isArray(p.parameters)) forceInputView(p.parameters);
            if (p && p.onchange && typeof p.onchange === "object") {
              Object.keys(p.onchange).forEach(function (k) {
                if (Array.isArray(p.onchange[k])) forceInputView(p.onchange[k]);
              });
            }
          });
        }
        $timeout(function () { forceInputView($scope.connectorParamFields); }, 50);
        $timeout(function () { forceInputView($scope.connectorParamFields); }, 250);
        // Also re-apply when onchange reveals new children.
        $scope.$on("csFields:fieldVisibleChange", function () {
          $timeout(function () { forceInputView($scope.connectorParamFields); }, 50);
        });
        // Keep config.params in sync with field defaults (e.g. picklist
        // first-option) so canAdvance/runWithCurrentRecord see them.
        params.forEach(function (p) {
          if (!Object.prototype.hasOwnProperty.call($scope.config.params, p.name)) {
            $scope.config.params[p.name] = p.value === undefined ? "" : p.value;
          }
        });
      } else if (src.kind === "playbook") {
        (src.inputVariables || []).forEach(function (v) {
          $scope.paramRows.push({
            name: v.name,
            title: v.label || v.name,
            type: v.type || "text",
          });
        });
      }
    };

    // -------- Resolve-preview (Jinja against current entity) --------------
    $scope.resolvePreview = null;
    $scope.resolvingPreview = false;
    $scope.previewParams = function () {
      $scope.resolvingPreview = true;
      $scope.resolvePreview = null;
      resolveAllParams($scope.config.params).then(
        function (resolved) {
          $scope.resolvingPreview = false;
          $scope.resolvePreview = resolved;
        },
        function (err) {
          $scope.resolvingPreview = false;
          $scope.resolvePreview = { __error: err && err.message };
        }
      );
    };

    function buildJinjaContext(extra) {
      var entity = $scope.entity;
      var record = entity && entity.originalData ? angular.copy(entity.originalData) : {};
      var ctx = { vars: { input: { records: [record] } } };
      if (extra && typeof extra === "object") angular.extend(ctx.vars.input, extra);
      return ctx;
    }

    function looksLikeJinja(val) {
      return typeof val === "string" && val.indexOf("{{") !== -1 && val.indexOf("}}") !== -1;
    }

    function resolveOne(value, ctx) {
      if (!looksLikeJinja(value)) return $q.when(value);
      return dynamicValueService
        .evaluateJinja({ template: value, values: ctx })
        .then(function (res) {
          return res && res.result;
        });
    }

    function resolveAllParams(params) {
      var ctx = buildJinjaContext();
      var keys = Object.keys(params || {});
      var out = {};
      var chain = $q.when();
      keys.forEach(function (k) {
        chain = chain.then(function () {
          return resolveOne(params[k], ctx).then(function (resolved) {
            out[k] = resolved;
          });
        });
      });
      return chain.then(function () {
        return out;
      });
    }

    // -------- Execute against current record ------------------------------
    $scope.executing = false;
    $scope.executedSample = null;
    $scope.lastExecutionError = null;
    $scope.executeStartedAt = null;
    $scope.executeElapsedMs = null;

    $scope.runWithCurrentRecord = function () {
      $scope.executing = true;
      $scope.lastExecutionError = null;
      $scope.executeStartedAt = Date.now();
      $scope.executedSample = null;

      resolveAllParams($scope.config.params)
        .then(function (resolvedParams) {
          var src = $scope.config.source;
          if (src.kind === "connector") {
            if (!connectorService) return $q.reject(new Error("connectorService unavailable"));
            return connectorService
              .executeConnectorAction(
                src.name,
                src.version,
                src.operation,
                src.config,
                resolvedParams,
                true,
                {},
                $scope.config.agent || undefined
              )
              .then(function (res) {
                // executeConnectorAction returns the response envelope; the
                // payload commonly hangs off res.data.
                if (res && Object.prototype.hasOwnProperty.call(res, "data")) {
                  return res.data;
                }
                return res;
              });
          }
          if (src.kind === "playbook") {
            return triggerPlaybookHeadless(src, resolvedParams);
          }
          return $q.reject(new Error("Unknown source kind"));
        })
        .then(
          function (result) {
            $scope.executing = false;
            $scope.executedSample = result;
            $scope.executeElapsedMs = Date.now() - $scope.executeStartedAt;
            // Bubble up to the inline jinja editor pane (it watches seedInput).
            $scope.$broadcast("actionRenderer:executedSample", result);
          },
          function (err) {
            $scope.executing = false;
            $scope.executeElapsedMs = Date.now() - $scope.executeStartedAt;
            $scope.lastExecutionError =
              (err && err.data && (err.data.message || err.data.detail)) ||
              (err && err.message) ||
              "Execution failed";
            toaster.error({ body: $scope.lastExecutionError });
          }
        );
    };

    function triggerPlaybookHeadless(src, params) {
      var pbSvc = getPlaybookService();
      if (!pbSvc) return $q.reject(new Error("playbookService unavailable"));
      var entity = $scope.entity;
      var recordIri = entity && entity.originalData && entity.originalData["@id"];
      var body = angular.extend({}, params || {});
      if (recordIri) body.records = [recordIri];
      // SOAR's /api/triggers/1/action/<route> endpoint identifies the
      // playbook by `__uuid` (the *playbook* uuid, not the record's) and
      // the entity collection by `__resource`. Mirroring playbookService.M
      // in app.unmin.js — passing the record uuid here is what causes the
      // "No workflow found for id <recordUuid>" 404.
      if (src.uuid) body.__uuid = src.uuid;
      if (entity && entity.module) body.__resource = entity.module;
      if (src.singleRecordExecution !== undefined) {
        body.singleRecordExecution = src.singleRecordExecution;
      }
      var url = API.ACTION_TRIGGER + src.route;
      return $resource(url)
        .save(body)
        .$promise.then(function (res) {
          var taskIds = [];
          if (res && res.task_ids && res.task_ids.length) taskIds = res.task_ids;
          else if (res && res.task_id) taskIds.push(res.task_id);
          if (!taskIds.length) {
            return { __triggered: true, response: res, message: "Triggered (no task id returned)." };
          }
          var deferred = $q.defer();
          try {
            pbSvc.checkPlaybookExecutionCompletion(
              taskIds,
              function (status) {
                if (!status) return;
                if (status.status !== "finished" && status.status !== "failed") return;
                if (!status.instance_ids) {
                  deferred.resolve({ __status: status.status, statusObject: status });
                  return;
                }
                pbSvc.getExecutedPlaybookLogData(status.instance_ids).then(
                  function (log) {
                    deferred.resolve(log && log.result !== undefined ? log.result : log);
                  },
                  function (err) { deferred.reject(err); }
                );
              },
              function () {
                deferred.reject(new Error("Failed to subscribe to playbook completion."));
              },
              $scope
            );
          } catch (e) {
            deferred.reject(e);
          }
          return deferred.promise;
        });
    }

    // -------- Output / table-shaping helpers -------------------------------
    // Resolves a dotted/bracket path against an object.
    $scope.resolvePath = function (obj, pathStr) {
      return resolveInputPath(obj, pathStr);
    };

    function resolveInputPath(obj, pathStr) {
      if (obj == null) return { found: false };
      if (!pathStr || !pathStr.trim()) return { found: true, value: obj };
      var segs = parsePath(pathStr);
      var val = obj;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s.kind === "index") {
          if (!Array.isArray(val) || s.idx < 0 || s.idx >= val.length) return { found: false };
          val = val[s.idx];
        } else {
          if (val == null || typeof val !== "object" || !(s.key in val)) return { found: false };
          val = val[s.key];
        }
      }
      return { found: true, value: val };
    }

    function parsePath(p) {
      var out = [];
      var cur = p;
      while (cur && cur.length) {
        var dot = cur.indexOf(".");
        var br = cur.indexOf("[");
        if (dot === -1 && br === -1) {
          out.push({ kind: "key", key: cur });
          break;
        }
        if (dot !== -1 && (br === -1 || dot < br)) {
          if (dot > 0) out.push({ kind: "key", key: cur.slice(0, dot) });
          cur = cur.slice(dot + 1);
        } else {
          if (br > 0) out.push({ kind: "key", key: cur.slice(0, br) });
          var close = cur.indexOf("]", br);
          if (close === -1) return out;
          var n = parseInt(cur.slice(br + 1, close), 10);
          out.push({ kind: "index", idx: n });
          cur = cur.slice(close + 1);
          if (cur[0] === ".") cur = cur.slice(1);
        }
      }
      return out;
    }

    $scope.tablePathStatus = function () {
      var rp = $scope.config.output.table.rootPath || "";
      var sample = $scope.executedSample;
      if (sample == null) return { kind: "no-sample" };
      var res = resolveInputPath(sample, rp);
      if (!res.found) return { kind: "missing" };
      var v = res.value;
      if (Array.isArray(v)) {
        return { kind: "array", count: v.length, sampleKeys: v.length && typeof v[0] === "object" ? Object.keys(v[0]).slice(0, 8) : [] };
      }
      if (v && typeof v === "object") return { kind: "object", keys: Object.keys(v).slice(0, 8) };
      return { kind: "primitive", value: String(v) };
    };

    $scope.addColumn = function () {
      $scope.config.output.table.columns.push({ path: "", header: "" });
    };
    $scope.removeColumn = function (i) {
      $scope.config.output.table.columns.splice(i, 1);
    };

    // Quick-fill columns from the current sample at rootPath (when array of objects).
    $scope.autoFillColumns = function () {
      var rp = $scope.config.output.table.rootPath || "";
      var res = resolveInputPath($scope.executedSample, rp);
      if (!res.found || !Array.isArray(res.value)) return;
      var keys = {};
      res.value.slice(0, 50).forEach(function (row) {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          Object.keys(row).forEach(function (k) { keys[k] = true; });
        }
      });
      $scope.config.output.table.columns = Object.keys(keys).slice(0, 20).map(function (k) {
        return { path: k, header: k };
      });
    };

    // -------- Inline Jinja pane bridge ------------------------------------
    // Two-way binding to config.output.jinjaTemplate is set up via the
    // <jinja-editor-pane> directive's `template` attribute in edit.html.
    // The directive reads `seedInput` for the input pane.
    $scope.jinjaPaneSeed = null;
    $scope.$watch("executedSample", function (v) {
      $scope.jinjaPaneSeed = v;
    });

    // -------- Modal lifecycle ---------------------------------------------
    $scope.save = function () {
      // cs-connector-field-renderer surfaces required-field validation
      // visually (red asterisks + cs-messages). We don't hard-block save —
      // a value may legitimately come from a Jinja expression resolved at
      // runtime, which the directive's $valid check can't see. Just trip
      // the form's submitted state so any inline error messages light up
      // before saving.
      var f = $scope.editForm;
      if (f && typeof f.$setSubmitted === "function") f.$setSubmitted();
      if (!$scope.canSave()) {
        try {
          toaster.error({ body: "Complete all four steps before saving (Source, Params, Run sample, Output)." });
        } catch (e) {}
        // Jump to the first step that isn't yet satisfied so the user sees
        // the gating field.
        if (!canAdvance(1)) $scope.gotoStep(1);
        else if (!canAdvance(2)) $scope.gotoStep(2);
        else if ($scope.maxStepReached < 4) $scope.gotoStep(Math.max($scope.activeStep, $scope.maxStepReached));
        return;
      }
      $uibModalInstance.close($scope.config);
    };
    $scope.cancel = function () { $uibModalInstance.dismiss("cancel"); };

    // -------- Init ---------------------------------------------------------
    function _init() {
      loadEntity();
      // Pre-load both lists so the user can flip between source kinds.
      if ($scope.config.source.kind === "connector") loadConnectorList();
      else loadPlaybookList();

      // If a connector was already chosen, fetch details + rebuild rows.
      if ($scope.config.source.kind === "connector" && $scope.config.source.name) {
        loadConnectorDetails($scope.config.source.name, $scope.config.source.version, false);
        $scope.rebuildParamRows();
      } else if ($scope.config.source.kind === "playbook" && $scope.config.source.iri) {
        $scope.rebuildParamRows();
      }
    }
    _init();
  }
})();
