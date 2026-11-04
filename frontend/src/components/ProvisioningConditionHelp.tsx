import { For, Show, type Component } from 'solid-js';
import { X } from 'lucide-solid';
import Dialog from './Dialog';

const examples = [
  ['Object instance exists', "exists('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.')"],
  ['Object instance is absent', "NOT exists('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.')"],
  ['Parameter exists, even with an empty value', "exists('InternetGatewayDevice.DeviceInfo.ModelName')"],
  ['Match a manufacturer', "InternetGatewayDevice.DeviceInfo.Manufacturer == 'SkyDash'"],
  ['Match part of a model name', "InternetGatewayDevice.DeviceInfo.ModelName contains 'AC1000'"],
  ['Compare a number', 'InternetGatewayDevice.DeviceInfo.UpTime >= 300'],
  ['Match a regular expression', "InternetGatewayDevice.DeviceInfo.ModelName matches '^AC[0-9]+$'"],
  ['Require a tag and an absent instance', "hasTag('branch-a') AND NOT exists('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.')"],
  ['Group alternatives and exclude a tag', "(hasTag('branch-a') OR hasTag('branch-b')) AND notHasTag('blocked')"],
];

const ConditionHelpContent: Component = () => (
    <div class="space-y-5 text-sm text-secondary">
      <section class="space-y-2">
        <h3 class="font-semibold text-primary">When conditions run</h3>
        <p>Leave Condition empty to always apply the rule, subject to its template, tags, trigger phase and enabled state. A false condition skips the rule.</p>
        <p>ACS checks conditions during the CWMP session. Value comparisons use values fetched from the CPE; existence checks query its current parameter names. Pending conditional rules share this check phase; a condition is not rechecked after every preceding conditional rule.</p>
      </section>
      <section class="space-y-2">
        <h3 class="font-semibold text-primary">Object and parameter existence</h3>
        <p><code>exists('path')</code> checks an exact object instance or parameter. Use the complete <code>InternetGatewayDevice</code> or <code>Device</code> path supported by the CPE. The final dot on an object path is optional. Wildcards, ranges and <code>{'{prev}'}</code> references are not supported here.</p>
        <p><code>NOT exists('path')</code> checks absence. A parameter with an empty value still exists; existence does not mean writable or enabled. An empty object is detected from its name, without requiring child values.</p>
        <p>If the CPE cannot verify existence, the affected condition is skipped, including a negated check. CWMP fault 9005 for the queried parent means the requested child is absent. Other faults are not treated as absence.</p>
      </section>
      <section class="space-y-2">
        <h3 class="font-semibold text-primary">Syntax and operators</h3>
        <p>Write a parameter path, an operator and a value. Put text in single or double quotes; numbers can be unquoted. Parameter names, text values and tags are case-sensitive.</p>
        <div class="overflow-x-auto table-scroll">
          <table class="data-table w-full text-left text-xs">
            <thead><tr><th data-column-order-id="operator#0" scope="col">Operator</th><th data-column-order-id="meaning#0" scope="col">Meaning</th></tr></thead>
            <tbody>
              <tr><td data-column-order-id="operator#0" class="font-mono">== / !=</td><td data-column-order-id="meaning#0">Equal / not equal (text comparison)</td></tr>
              <tr><td data-column-order-id="operator#0" class="font-mono">&gt; / &lt; / &gt;= / &lt;=</td><td data-column-order-id="meaning#0">Numeric comparison when both values are numeric; otherwise text order</td></tr>
              <tr><td data-column-order-id="operator#0" class="font-mono">contains</td><td data-column-order-id="meaning#0">Value contains the given text</td></tr>
              <tr><td data-column-order-id="operator#0" class="font-mono">matches</td><td data-column-order-id="meaning#0">Value matches a Go regular expression; use ^ and $ for a full match</td></tr>
              <tr><td data-column-order-id="operator#0" class="font-mono">AND / OR / NOT</td><td data-column-order-id="meaning#0">Both / either / negate; precedence is NOT, then AND, then OR</td></tr>
            </tbody>
          </table>
        </div>
        <p>Use parentheses to group expressions. <code>hasTag('name')</code> requires an exact device tag; <code>notHasTag('name')</code> requires its absence. These functions combine with comparisons and <code>exists()</code>.</p>
        <p>Available device attributes: <code>device.manufacturer</code>, <code>device.product_class</code> and <code>device.tags</code>. Prefer tag functions for exact tag matching.</p>
      </section>
      <section class="space-y-3">
        <h3 class="font-semibold text-primary">Examples</h3>
        <For each={examples}>{([label, expression]) => (
          <div class="space-y-1">
            <p class="font-medium">{label}</p>
            <pre class="whitespace-pre-wrap break-all text-xs font-mono border border-subtle p-3"><code>{expression}</code></pre>
          </div>
        )}</For>
      </section>
      <section class="space-y-2">
        <h3 class="font-semibold text-primary">Common pitfalls</h3>
        <p>Use an instance path to check a specific index. A count greater than zero does not prove that index 1 exists: the CPE may have only index 2 or 3.</p>
        <p>Do not use <code>path != ''</code> to test existence. Missing operands in comparisons currently fall back to their literal path text. Use <code>exists()</code> for presence and <code>NOT exists()</code> for absence.</p>
        <p>Use paths from the target CPE's data model. <code>Device</code> and <code>InternetGatewayDevice</code> are different roots and are not automatically translated.</p>
      </section>
    </div>
);

const ProvisioningConditionHelp: Component<{ onClose: () => void; inline?: boolean }> = (props) => (
  <Show when={props.inline} fallback={
    <Dialog title="Condition help" size="large" onClose={props.onClose}
      description="Apply a provisioning rule only when an expression is true."
      actions={<button type="button" class="btn btn-secondary" onClick={props.onClose}>Close help</button>}>
      <ConditionHelpContent />
    </Dialog>
  }>
    <aside id="provisioning-condition-help" class="dialog-side-panel" aria-label="Condition help">
      <header class="dialog-header">
        <div class="dialog-header-content"><h2>Condition help</h2><p>Apply a provisioning rule only when an expression is true.</p></div>
        <button type="button" class="icon-button" onClick={props.onClose} aria-label="Close condition help"><X size={17} aria-hidden="true" /></button>
      </header>
      <div class="dialog-body" tabindex="0" role="region" aria-label="Condition help reference"><ConditionHelpContent /></div>
    </aside>
  </Show>
);

export default ProvisioningConditionHelp;
