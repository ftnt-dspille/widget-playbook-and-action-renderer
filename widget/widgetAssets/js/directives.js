/* Copyright start
   MIT License
   Copyright (c) 2026 Dylan Spille
   Copyright end */
"use strict";
(function () {
  // Sandboxed iframe HTML preview, copied from the standalone Jinja editor
  // widget. The empty `sandbox` attribute disables scripts, plugins, form
  // submission, popups, and same-origin access — rendered output cannot
  // reach the parent SOAR page in any way. Mirrors the parent's stylesheet
  // links so json2html-style tables look themed.
  function actionRendererHtmlPreviewDirective() {
    return {
      restrict: "A",
      scope: { html: "=actionRendererHtmlPreview" },
      template:
        '<iframe class="action-renderer-html-frame" sandbox="" referrerpolicy="no-referrer"></iframe>',
      link: function (scope, element) {
        var iframe = element[0].querySelector("iframe");
        function collectStylesheetLinks() {
          var links = document.querySelectorAll('link[rel="stylesheet"][href]');
          var html = "";
          for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute("href");
            if (!href) continue;
            var abs = new URL(href, document.baseURI).href;
            html += '<link rel="stylesheet" href="' + abs.replace(/"/g, "&quot;") + '">';
          }
          return html;
        }
        function render(html) {
          var trimmed = (html || "").trim();
          var needsWrap = /^<\s*(tr|td|th)\b/i.test(trimmed);
          var body = needsWrap ? "<table>" + trimmed + "</table>" : trimmed;
          iframe.srcdoc =
            '<!doctype html><html><head><meta charset="utf-8"><base href="' +
            document.baseURI +
            '">' +
            collectStylesheetLinks() +
            "<style>body{font-family:system-ui,sans-serif;font-size:13px;margin:8px;background:#fff;color:#222}" +
            "table:not([class]){border-collapse:collapse}" +
            "table:not([class]) th,table:not([class]) td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}" +
            "table:not([class]) th{background:#f3f3f3}" +
            "table td{background:#fff;color:#222}" +
            "table tr:nth-child(even) td{background:#f7f7f9}" +
            "</style></head><body>" +
            body +
            "</body></html>";
        }
        scope.$watch("html", render);
      },
    };
  }

  // Inline Jinja editor pane. Lighter than the standalone widget (no Monaco
  // autocomplete, no filter palette) but provides the round-trip experience:
  // see the input, edit a template, render via dynamicValueService, and view
  // the result as Raw / JSON / HTML.
  //
  // Bindings:
  //   seed-input  — object/array used as the template's input; rendered
  //                 read-only on the left.
  //   template    — two-way string bound to the template editor.
  //
  // Render: POST {template, values:{vars:{input:{records:[record], result:seed}}}}
  // The "record" comes from $state.params.module/id when available, so the
  // template can reference the current record alongside the executed result.
  actionRendererJinjaPaneDirective.$inject = [
    "$timeout",
    "dynamicValueService",
    "Modules",
    "$state",
    "toaster",
  ];
  function actionRendererJinjaPaneDirective(
    $timeout,
    dynamicValueService,
    Modules,
    $state,
    toaster
  ) {
    return {
      restrict: "A",
      scope: {
        seedInput: "=seedInput",
        template: "=template",
      },
      template: [
        '<div class="action-renderer-jinja-pane-inner">',
        '  <div class="row">',
        '    <div class="col-sm-4">',
        '      <div class="display-flex-space-between">',
        '        <label class="control-label margin-bottom-0">Input (executed sample)</label>',
        '        <small class="muted-65" data-ng-if="!seedInput">none yet</small>',
        '      </div>',
        '      <pre class="action-renderer-jinja-input">{{ seedJsonText }}</pre>',
        '    </div>',
        '    <div class="col-sm-4">',
        '      <div class="display-flex-space-between">',
        '        <label class="control-label margin-bottom-0">Template</label>',
        '        <button type="button" class="btn btn-primary btn-xs"',
        '                data-ng-click="render()"',
        '                data-ng-disabled="rendering || !template">',
        '          <i class="fa fa-arrow-right margin-right-sm" data-ng-if="!rendering"></i>',
        '          <i class="fa fa-spinner fa-spin margin-right-sm" data-ng-if="rendering"></i>',
        '          Render',
        '        </button>',
        '      </div>',
        '      <textarea class="form-control action-renderer-jinja-template"',
        '                data-ng-model="template"',
        '                spellcheck="false"',
        '                rows="14"',
        '                placeholder="Jinja template — reference vars.input.result"></textarea>',
        '    </div>',
        '    <div class="col-sm-4">',
        '      <div class="display-flex-space-between">',
        '        <label class="control-label margin-bottom-0">Output</label>',
        '        <ul class="nav nav-pills action-renderer-jinja-tabs">',
        '          <li data-ng-class="{ active: outputTab === \'raw\' }"><a href="" data-ng-click="setTab(\'raw\')">Raw</a></li>',
        '          <li data-ng-class="{ active: outputTab === \'json\' }"><a href="" data-ng-click="setTab(\'json\')">JSON</a></li>',
        '          <li data-ng-class="{ active: outputTab === \'html\' }"><a href="" data-ng-click="setTab(\'html\')">HTML</a></li>',
        '        </ul>',
        '      </div>',
        '      <pre class="action-renderer-jinja-output"',
        '           data-ng-class="{ \'has-error\': isError }"',
        '           data-ng-if="outputTab !== \'html\'">{{ outputDisplay }}</pre>',
        '      <div class="action-renderer-jinja-output-html"',
        '           data-action-renderer-html-preview="output"',
        '           data-ng-if="outputTab === \'html\'"></div>',
        '    </div>',
        '  </div>',
        '</div>',
      ].join("\n"),
      link: function (scope) {
        scope.output = null;
        scope.outputDisplay = "";
        scope.isError = false;
        scope.rendering = false;
        scope.outputTab = "raw";
        scope.recordContext = null;

        scope.setTab = function (t) { scope.outputTab = t; };

        function refreshSeedJson() {
          try {
            scope.seedJsonText = scope.seedInput == null ? "" : JSON.stringify(scope.seedInput, null, 2);
          } catch (e) {
            scope.seedJsonText = String(scope.seedInput);
          }
        }
        scope.$watch("seedInput", refreshSeedJson);

        function refreshOutputDisplay() {
          var o = scope.output;
          if (o == null) {
            scope.outputDisplay = "";
            return;
          }
          if (typeof o === "object") {
            try { scope.outputDisplay = JSON.stringify(o, null, 2); }
            catch (_) { scope.outputDisplay = String(o); }
            return;
          }
          if (typeof o === "string" && (o.trim()[0] === "{" || o.trim()[0] === "[")) {
            try { scope.outputDisplay = JSON.stringify(JSON.parse(o), null, 2); return; }
            catch (_) { /* fall through */ }
          }
          scope.outputDisplay = String(o);
        }
        scope.$watch("output", function () {
          refreshOutputDisplay();
          // Auto-pick a sensible default tab when output type changes.
          var o = scope.output;
          if (o == null) return;
          if (typeof o === "object") scope.outputTab = "json";
          else if (typeof o === "string" && /<\s*[a-z][\s\S]*>/i.test(o.slice(0, 400))) scope.outputTab = "html";
          else scope.outputTab = "raw";
        });

        // Pull the current record so templates can reference it alongside
        // the executed result. Best-effort; failures are silent.
        function loadRecordContext() {
          var module = $state && $state.params && $state.params.module;
          var id = $state && $state.params && $state.params.id;
          if (!module || !id) return;
          Modules.get({ module: module, id: id }).$promise.then(function (rec) {
            var clone = angular.copy(rec);
            delete clone.$promise;
            delete clone.$resolved;
            scope.recordContext = clone;
          });
        }
        loadRecordContext();

        scope.render = function () {
          if (!scope.template) {
            toaster.warning({ body: "Template is empty." });
            return;
          }
          var record = scope.recordContext || {};
          var values = { vars: { input: { records: [record], result: scope.seedInput } } };
          scope.rendering = true;
          scope.isError = false;
          dynamicValueService
            .evaluateJinja({ template: scope.template, values: values })
            .then(
              function (res) {
                scope.output = res && res.result;
                scope.isError = false;
              },
              function (err) {
                scope.isError = true;
                var msg =
                  (err && err.data && (err.data.message || err.data.detail)) ||
                  (err && err.statusText) ||
                  "Render failed";
                scope.output = "Error: " + msg;
              }
            )
            .finally(function () {
              scope.rendering = false;
            });
        };

        // Also listen for the parent edit controller's executed-sample event
        // so freshly-run samples seed the input even before $watch fires.
        scope.$on("actionRenderer:executedSample", function (_e, sample) {
          scope.seedInput = sample;
          refreshSeedJson();
        });
      },
    };
  }

  // Guard against duplicate registration when the script is loaded by multiple
  // instances of the widget on the same page. Angular doesn't error on
  // re-register, but the duplicate work is wasted.
  if (!window.__actionRendererWidgetDirectivesRegistered) {
    window.__actionRendererWidgetDirectivesRegistered = true;
    angular
      .module("cybersponse")
      .directive("actionRendererHtmlPreview", actionRendererHtmlPreviewDirective)
      .directive("actionRendererJinjaPane", actionRendererJinjaPaneDirective);
  }
})();
