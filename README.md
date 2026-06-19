# Action Renderer Widget

Run a connector action or action-trigger playbook against the current record
and render the output as raw JSON, a shaped table, or HTML produced by an
inline Jinja template.

## Files

```
widget/
  info.json                    – widget manifest (name + version)
  edit.html                    – 4-step config wizard (Source → Params → Run sample → Output)
  edit.controller.js           – editActionRendererWidget100DevCtrl
  view.html                    – view-panel render shell (raw / table / jinja)
  view.controller.js           – actionRendererWidget100DevCtrl
  widgetAssets/
    css/actionRenderer.css
    js/directives.js           – actionRendererJinjaPane + actionRendererHtmlPreview
tests/                         – jest + jsdom + angular-mocks
  e2e/                         – Playwright specs (need the devkit — see Testing)
jest.config.js
```

## Testing

Two tiers, both living in `tests/`:

- **Unit (jest)** — `tests/*.test.js`. Self-contained; runnable from a bare
  clone of this repo (`npx jest` or via the devkit `make test-unit
  WIDGET=widget-action-renderer`).
- **E2E (Playwright)** — `tests/e2e/*.spec.js`. **These depend on the
  fsr-widget-devkit checkout** and do NOT run from a bare clone of this repo.
  They require this widget to sit at `devkit/widgets-src/<widget>/` with a
  sibling `fortisoar-widget-harness/`: the harness boots the dev server, its
  Playwright "widgets" project (testDir = the canonicalized `widgets-src`)
  discovers these specs, and the `*Live*.spec.js` ones drive a real box through
  the harness proxy. They reach harness helpers (`_probe`, `soarBrowser`,
  `viewTemplate`) via relative `../../../../fortisoar-widget-harness/...` paths
  that only resolve inside the devkit layout.

  Run e2e from the devkit root, never standalone:
  ```
  make test-e2e-widget WIDGET=widget-action-renderer        # mock tier
  make test-e2e-spec SPEC=widgets-src/widget-action-renderer/tests/e2e/<file>.spec.js
  E2E_LIVE=1 ...                                             # *Live* specs (real box)
  ```
  `*Live*.spec.js` specs are excluded unless `E2E_LIVE=1`.

Asset paths in HTML use the `actionRendererWidget-1.0.0/...` prefix because
both the dev harness and SOAR's installed-widget mount serve files under
`<name>-<version>/`. **Bumping `info.json.version` requires updating these
paths and the controller suffix** (`100Dev` for `1.0.0`); the harness's
package endpoint runs `syncSourceToInfoJson` which handles this for you on
package, but if you bump manually you have to update them by hand.

## Persisted config shape

```js
{
  title,
  autoExecute,                 // default true; false suppresses on-load run
  agent,                       // optional connector agent
  source: {
    kind: 'connector' | 'playbook',
    // connector:
    name, version, label, icon,
    operation, operationTitle, parameters, configRequired,
    config,                    // configuration id
    // playbook:
    uuid, iri, name, title,
    route,                     // trigger route (POST'd to API.ACTION_TRIGGER + route)
    singleRecordExecution,
    inputVariables: [{ name, type, label }],
  },
  params: { [paramName]: 'literal-or-{{jinja}}' },
  output: {
    mode: 'raw' | 'table' | 'jinja',
    table: {
      rootPath,                // dotted/bracket, e.g. 'data.hits[0]'
      mode: 'auto' | 'columns',
      columns: [{ path, header }],
      emptyMessage,
    },
    jinjaTemplate,             // string; rendered with vars.input.result + vars.input.records[0]
  },
}
```

## Runtime data flow

### View panel

1. `FormEntityService.get()` → current record.
2. For each `params[k]` whose value contains `{{`/`}}`, call
   `dynamicValueService.evaluateJinja({template, values: {vars:{input:{records:[record]}}}})`.
3. Connector path: `connectorService.executeConnectorAction(name, version, op, configId, resolvedParams, true, {}, agent)`.
   The result is unwrapped from `res.data` if present.
4. Playbook path: POST directly to `API.ACTION_TRIGGER + route` with body
   `{...resolvedParams, records:[iri], __resource: module, __uuid, singleRecordExecution}`,
   then resolve through `playbookService.checkPlaybookExecutionCompletion(taskIds, success, error, $scope)`
   → `getExecutedPlaybookLogData(instance_ids)` → `log.result` (falls back to log if no `result` field).
   This deliberately **bypasses `triggerPlaybookAction`** so users don't get the SOAR
   `inputVariables` modal popup — params are pre-resolved and posted headlessly.
5. Render based on `output.mode`. Jinja mode uses
   `evaluateJinja({template: output.jinjaTemplate, values: {vars:{input:{records:[record], result}}}})`
   and renders the HTML in a sandboxed `<iframe sandbox="">` so script-bearing
   template output cannot reach the SOAR DOM.

### Edit panel

The edit wizard runs the same execute-and-render pipeline (Step 3 → Step 4)
so the user can iterate on Jinja templates against a real executed sample.
The inline Jinja pane (`<div data-action-renderer-jinja-pane>`) is a custom
directive — not the standalone Jinja Editor widget — so it has no Monaco /
filter palette / autocomplete; just textarea + Render + Raw/JSON/HTML tabs.
If you need full editor features, configure with `output.mode === 'jinja'`,
save, and edit the template in the standalone Jinja Editor widget on the
same view panel.

## Dev harness gotchas

### Lazy `$injector.get(...)` for connectorService/playbookService

`playbookService` transitively depends on `websocketService` → `$stomp` →
`$stompProvider`. SOAR's `$stomp` is provided by the `angular-stomp`
vendor module, which the harness didn't ship. The harness now registers a
no-op `$stompProvider` stub in `harness.module.js` (search for
`$stomp provider stub`) — `connect()` returns a never-resolving promise so
`$rootScope.websocketConnected` stays false and SOAR's
`checkPlaybookExecutionCompletion` polling fallback (app.unmin.js ~38201)
runs over the harness proxy via `/api/wf/api/workflows/log_list`.

Even with the stub in place, both controllers still grab those services
through `$injector.get(...)` rather than `$inject` so a missing-provider
chain in any future harness build degrades gracefully instead of killing
the whole controller:

```js
function lazyService(name) {
  try { return $injector.get(name); } catch (e) { return null; }
}
var connectorService = lazyService("connectorService");
function getPlaybookService() { return lazyService("playbookService"); }
```

If you ever see "Playbook source is unavailable in this environment…",
check that `harness.module.js` still has the `$stomp` provider stub.
After editing the harness module, reload the harness browser page —
`harness.module.js` is served fresh each load (no cache), but the change
won't pick up until the next bootstrap.

### `<script>` and `<link>` tags in edit.html

`edit.html` is loaded via `ng-include`. Angular's `$compile` does **not**
execute `<script>` tags inside compiled templates (they're treated as
template-cache markers). The directive bundle (`widgetAssets/js/directives.js`)
must be loaded by `view.html` (which the harness loads as a normal HTML
fragment with executed script tags) or by some other route. In SOAR
production, `view.html` loads on the dashboard and registers the directives
on the `cybersponse` module; the directives are then reusable from
`edit.html` in the same browser session. If you open `edit.html` in
isolation in the harness without first loading `view.html`, the inline
Jinja pane in Step 4 will render as a plain `<div>` with no behavior.

The harness also strips `.modal-header` and `.modal-footer` from the
edit modal body via CSS (`#edit-modal-body .modal-footer { display: none }`),
so the embedded Cancel/Save row in `edit.html` is hidden — the harness's own
modal chrome wires save/close. Both render in production.

### Don't put `data-ng-controller` on the view.html root

See the note at the top of `view.html`: SOAR's publish step strips the `Dev`
suffix from controller names, but a `data-ng-controller` attribute would
still reference the pre-strip `DevCtrl` name and create a parallel scope
that loses bindings. The harness wraps with its own `ng-controller`; SOAR
instantiates by name on the compile scope.

## API reference (services we use)

| Service                            | Method                                                                 | Notes                                                        |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `connectorService`                 | `loadConnectors(status?)`                                              | `'Completed'` filters to installed connectors                |
|                                    | `getConnector(name, version, agent?)`                                  | returns operations[] + configurations[]                      |
|                                    | `executeConnectorAction(name, ver, op, cfg, params, audit, info, agent)` | response payload usually under `res.data`                    |
| `playbookService`                  | `getActionPlaybooks(entity, withSelectedFields)`                       | returns hydra members for the entity's module                |
|                                    | `getTriggerStep(playbook)`                                             | returns the trigger step                                     |
|                                    | `checkPlaybookExecutionCompletion(ids, ok, err, scope)`                | websocket if connected, falls back to polling                |
|                                    | `getExecutedPlaybookLogData(instanceId)`                               | returns the workflow log; result lives at `log.result`       |
| `dynamicValueService.evaluateJinja({template, values})`                                                | `res.result` is the rendered string                          |
| `FormEntityService.get()`          |                                                                        | view-panel only; null in dashboard context                   |
| `API.ACTION_TRIGGER`               | `'api/triggers/1/action/'`                                             | suffix: route from `triggerStep.arguments.route`             |

## Testing

```bash
cd fortisoar-widget-harness
npx jest --selectProjects widget-action-renderer
```

38 tests cover: config defaults + rehydration, source-kind switching,
connector/playbook selection, param Jinja resolution, execute happy/error
paths, table-shaping helpers, modal lifecycle, and step gating. Tests fake
`$injector` to inject test-supplied `connectorService` / `playbookService`
without booting the real SOAR services.

Both controllers use `$q` rather than native `Promise` so async chains stay
inside Angular's digest cycle — required for tests, and slightly more
correct at runtime.

## Known gaps / v2 ideas

- **No Monaco / filter palette in the inline Jinja pane.** It's a textarea
  with Render, Raw/JSON/HTML tabs. The standalone Jinja Editor widget
  remains the place for the full authoring experience; the inline pane is
  for fast inline iteration.
- **No `cs-connector-field-renderer` for connector params** — params are
  rendered as plain Jinja-aware textareas. Per-type widgets (date pickers,
  picklist dropdowns, record-field references) would need the renderer wired
  in plus `connector` / `connectorData` context.
- **Playbook execution polls the workflow log.** If the workflow finishes
  via websocket the result is fast; on polling fallback (no websocket /
  no `SystemWaitForCompletion` tag) the `result` field on the log may be
  empty for playbooks that don't explicitly set a playbook result. Consider
  tagging the playbook with `SystemWaitForCompletion` if you need
  synchronous results — the existing SOAR code path uses `force_debug=true`
  for those.
- **Cache + refresh cadence.** Currently the view re-executes on every
  mount when `autoExecute !== false`. A `cacheTtlSec` option exists in the
  proposed schema but isn't wired yet.
