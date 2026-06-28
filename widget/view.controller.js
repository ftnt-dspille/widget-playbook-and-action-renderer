/* Copyright start
   MIT License
   Copyright (c) 2026 Dylan Spille
   Copyright end */
"use strict";
(function () {
  // Resolve the widget's own base URL from this script's src so directive
  // assets can be loaded relative to it in both the dev harness and SOAR.
  var WIDGET_BASE = (function () {
    var scriptEl =
      document.currentScript ||
      (function () {
        var s = document.getElementsByTagName("script");
        return s[s.length - 1];
      })();
    var src = (scriptEl && scriptEl.src) || "";
    return src.replace(/view\.controller\.js(?:\?.*)?$/, "");
  })();

  var WIDGET_VERSION = (function () {
    var m = WIDGET_BASE.match(/-(\d+(?:\.\d+)+)\/?$/);
    return m ? m[1] : "";
  })();

  angular
    .module("cybersponse")
    .controller(
      "actionRendererWidget108DevCtrl",
      actionRendererWidget108DevCtrl
    );

  // playbookService transitively depends on websocketService -> $stomp ->
  // $stompProvider, which the dev harness doesn't register. Lazy-loading
  // these services through $injector lets the controller instantiate even
  // when those provider chains are unavailable, so connector-source widgets
  // still render in the harness.
  actionRendererWidget108DevCtrl.$inject = [
    "$scope",
    "$state",
    "config",
    "FormEntityService",
    "dynamicValueService",
    "toaster",
    "$resource",
    "API",
    "$timeout",
    "$q",
    "$injector",
  ];

  function actionRendererWidget108DevCtrl(
    $scope,
    $state,
    config,
    FormEntityService,
    dynamicValueService,
    toaster,
    $resource,
    API,
    $timeout,
    $q,
    $injector
  ) {
    function lazyService(name) {
      try { return $injector.get(name); } catch (e) { return null; }
    }
    var connectorService = lazyService("connectorService");
    function getPlaybookService() { return lazyService("playbookService"); }
    $scope.config = config || {};
    $scope.widgetVersion = WIDGET_VERSION;

    $scope.loading = false;
    $scope.error = null;
    $scope.result = null;
    $scope.renderedHtml = null;
    $scope.tableRows = []; // [{cells:[{header, value, kind}]}]
    $scope.tableHeaders = [];
    // Column index -> alignment lookup. Built from config.output.table.columns
    // when in 'columns' mode; auto mode infers from cell content type.
    $scope.tableColumnAlign = function (idx) {
      var cfg = ($scope.config.output && $scope.config.output.table) || {};
      if (cfg.mode === "columns" && cfg.columns && cfg.columns[idx]) {
        return cfg.columns[idx].align;
      }
      var sample = $scope.tableRows && $scope.tableRows[0] && $scope.tableRows[0][idx];
      if (typeof sample === "number" || /^-?\d+(\.\d+)?$/.test(String(sample || ""))) return "right";
      return "left";
    };

    $scope.outputMode = ($scope.config.output && $scope.config.output.mode) || "raw";

    // ------- Path resolution helpers (dotted/bracket path) ----------------
    function parsePath(p) {
      var out = [];
      if (!p) return out;
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
    function resolvePath(obj, path) {
      var segs = parsePath(path);
      var v = obj;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s.kind === "index") {
          if (!Array.isArray(v) || s.idx < 0 || s.idx >= v.length) return undefined;
          v = v[s.idx];
        } else {
          // Auto-descend a single-element array: connector/playbook results
          // often wrap the payload as `[ { ...fields } ]`, so let a key path
          // reach into the lone element (e.g. "result.data" when result is
          // [{data:[…]}]) without forcing an explicit "result[0]". Only safe
          // for length-1 arrays; multi-element arrays still need an index.
          if (Array.isArray(v) && v.length === 1) v = v[0];
          if (v == null || typeof v !== "object" || !(s.key in v)) return undefined;
          v = v[s.key];
        }
      }
      return v;
    }

    // ------- Entity / Jinja context ---------------------------------------
    function getEntity() {
      try { return FormEntityService.get(); } catch (e) { return null; }
    }
    function buildContext(extra) {
      var entity = getEntity();
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
        .then(function (res) { return res && res.result; });
    }
    function resolveAllParams(params) {
      var ctx = buildContext();
      var keys = Object.keys(params || {});
      var out = {};
      var chain = $q.when();
      keys.forEach(function (k) {
        chain = chain.then(function () {
          return resolveOne(params[k], ctx).then(function (v) { out[k] = v; });
        });
      });
      return chain.then(function () { return out; });
    }

    // ------- Execute -------------------------------------------------------
    function execute() {
      var src = $scope.config.source;
      if (!src || !src.kind) {
        $scope.loading = false;
        $scope.error = "Widget is not configured — open the editor and pick a source.";
        return;
      }
      $scope.loading = true;
      $scope.error = null;
      $scope.result = null;

      resolveAllParams($scope.config.params || {})
        .then(function (resolved) {
          if (src.kind === "connector") {
            if (!connectorService) return $q.reject(new Error("connectorService unavailable"));
            return connectorService
              .executeConnectorAction(
                src.name,
                src.version,
                src.operation,
                src.config,
                resolved,
                true,
                {},
                $scope.config.agent || undefined
              )
              .then(function (res) {
                if (res && Object.prototype.hasOwnProperty.call(res, "data")) return res.data;
                return res;
              });
          }
          if (src.kind === "playbook") {
            return triggerPlaybookHeadless(src, resolved);
          }
          throw new Error("Unknown source kind");
        })
        .then(
          function (result) {
            $scope.loading = false;
            $scope.result = result;
            postProcessOutput();
          },
          function (err) {
            $scope.loading = false;
            $scope.error =
              (err && err.data && (err.data.message || err.data.detail)) ||
              (err && err.message) ||
              "Execution failed";
          }
        );
    }

    function triggerPlaybookHeadless(src, params) {
      var pbSvc = getPlaybookService();
      if (!pbSvc) return $q.reject(new Error("playbookService unavailable"));
      var entity = getEntity();
      var body = angular.extend({}, params || {});
      var iri = entity && entity.originalData && entity.originalData["@id"];
      if (iri) body.records = [iri];
      // Generic / referenced / manual playbooks (no action route) are fired via
      // the manual-trigger endpoint by playbook UUID, mirroring the platform's
      // own "Run" action (playbookService: MANUAL_TRIGGER + getEndPathName(@id)).
      // Record-context action triggers use the action endpoint by route +
      // {__uuid,__resource}. triggerType is set at pick time; fall back to the
      // presence of a route for configs saved before triggerType existed.
      var isManual = src.triggerType === "manual" || !src.route || src.noRecordExecution === true;
      var url;
      if (isManual) {
        var MANUAL = (API && API.MANUAL_TRIGGER) || "api/triggers/1/notrigger/";
        url = MANUAL + src.uuid;
      } else {
        // __uuid is the *playbook* uuid (not the record's); __resource is the
        // entity module. See playbookService.M in app.unmin.js.
        if (src.uuid) body.__uuid = src.uuid;
        if (entity && entity.module) body.__resource = entity.module;
        if (src.singleRecordExecution !== undefined) {
          body.singleRecordExecution = src.singleRecordExecution;
        }
        url = API.ACTION_TRIGGER + src.route;
      }
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
                  function (log) { deferred.resolve(log && log.result !== undefined ? log.result : log); },
                  function (e) { deferred.reject(e); }
                );
              },
              function () { deferred.reject(new Error("Failed to subscribe to playbook completion.")); },
              $scope
            );
          } catch (e) { deferred.reject(e); }
          return deferred.promise;
        });
    }

    // ------- Output postprocess -------------------------------------------
    function postProcessOutput() {
      $scope.tableRows = [];
      $scope.tableHeaders = [];
      $scope.renderedHtml = null;
      $scope.resultJsonText = "";
      try {
        $scope.resultJsonText = JSON.stringify($scope.result, null, 2);
      } catch (e) {
        $scope.resultJsonText = String($scope.result);
      }

      if ($scope.outputMode === "table") {
        buildTable();
      } else if ($scope.outputMode === "jinja") {
        renderJinjaTemplate();
      }
    }

    function buildTable() {
      var cfg = ($scope.config.output && $scope.config.output.table) || {};
      var rooted = resolvePath($scope.result, cfg.rootPath || "");
      if (rooted === undefined) {
        $scope.tableHeaders = [];
        $scope.tableRows = [];
        return;
      }
      // Normalize to an array of rows.
      var rows = [];
      if (Array.isArray(rooted)) rows = rooted;
      else if (rooted && typeof rooted === "object") rows = [rooted];
      // A bare primitive root is kept as the row itself so the auto-mode
      // "value" column formats it directly (formatCell(7) -> "7"); wrapping it
      // as {value:7} would instead stringify the wrapper into the cell.
      else rows = [rooted];

      var headers, cols;
      if (cfg.mode === "columns" && cfg.columns && cfg.columns.length) {
        cols = cfg.columns;
        headers = cols.map(function (c) { return c.header || c.path; });
        $scope.tableHeaders = headers;
        $scope.tableRows = rows.map(function (row) {
          return cols.map(function (c) {
            var v = c.path ? resolvePath(row, c.path) : row;
            return formatCell(v);
          });
        });
      } else {
        // Auto: union of keys (row-of-objects) or single-column "value".
        if (rows.every(function (r) { return r && typeof r === "object" && !Array.isArray(r); })) {
          var keySet = {};
          rows.slice(0, 100).forEach(function (r) {
            Object.keys(r).forEach(function (k) { keySet[k] = true; });
          });
          headers = Object.keys(keySet).slice(0, 20);
        } else {
          headers = ["value"];
        }
        $scope.tableHeaders = headers;
        $scope.tableRows = rows.map(function (row) {
          if (headers.length === 1 && headers[0] === "value") return [formatCell(row)];
          return headers.map(function (k) { return formatCell(row && row[k]); });
        });
      }
    }

    function formatCell(v) {
      if (v == null) return "";
      if (typeof v === "object") {
        try { return JSON.stringify(v); } catch (e) { return String(v); }
      }
      return String(v);
    }

    function renderJinjaTemplate() {
      var template = $scope.config.output && $scope.config.output.jinjaTemplate;
      if (!template) {
        $scope.renderedHtml = "";
        return;
      }
      var ctx = buildContext({ result: $scope.result });
      dynamicValueService.evaluateJinja({ template: template, values: ctx }).then(
        function (res) { $scope.renderedHtml = (res && res.result) || ""; },
        function (err) {
          $scope.renderedHtml = null;
          $scope.error =
            "Template error: " +
            ((err && err.data && (err.data.message || err.data.detail)) ||
              (err && err.statusText) ||
              "render failed");
        }
      );
    }

    $scope.refresh = execute;

    // Re-run the output postprocess against the current $scope.result without
    // re-executing the source. Exposed so callers (and render tests) can switch
    // output mode/style and re-render a held result; also handy for a manual
    // "re-render" after editing output config in place.
    $scope.applyOutput = function () {
      $scope.outputMode = ($scope.config.output && $scope.config.output.mode) || "raw";
      postProcessOutput();
    };

    // ------- Init ---------------------------------------------------------
    function _init() {
      // autoExecute defaults to true; respect false to require manual click.
      var auto = $scope.config.autoExecute !== false;
      if (auto) {
        // Defer to allow $state to settle on view-panel context.
        $timeout(execute, 0);
      }
    }
    _init();
  }
})();
