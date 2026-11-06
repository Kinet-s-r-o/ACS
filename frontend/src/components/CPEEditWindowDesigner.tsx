import { createEffect, createResource, createSignal, Index, onCleanup, Show, type Component } from 'solid-js';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-solid';
import { api, type CPEEditField, type CPEEditParameterMetadata, type CPEEditTab, type CPEEditTarget, type CPEEditWindow, type ProvisioningTemplate } from '../lib/api';
import { editFieldInput, editFieldSensitive, editWindowTargets, newCPEEditWindow, validateCPEEditValue } from '../lib/cpeEditWindows';
import { useAuth } from '../lib/auth';
import Dialog from './Dialog';
import CPEEditWindowFields from './CPEEditWindowFields';
import { useFeedback } from './Feedback';
import { ResourceError } from './ResourceState';

const CPEEditWindowDesigner: Component<{ template: ProvisioningTemplate; onSaved: (windows: CPEEditWindow[]) => void }> = props => {
  const { can } = useAuth();
  const { confirm, notify } = useFeedback();
  const [open, setOpen] = createSignal(false);
  const [windows, setWindows] = createSignal<CPEEditWindow[]>([]);
  const [initial, setInitial] = createSignal('');
  const [target, setTarget] = createSignal<CPEEditTarget>('wifi');
  const [tabID, setTabID] = createSignal('');
  const [fieldID, setFieldID] = createSignal('');
  const [reference, setReference] = createSignal('');
  const [referenceSearch, setReferenceSearch] = createSignal('');
  const [parameterSearch, setParameterSearch] = createSignal('');
  const [picked, setPicked] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const editable = () => can('settings.provisioning', 'write') && !saving();
  const dirty = () => initial() !== JSON.stringify(windows());
  const window = () => windows().find(item => item.target === target())!;
  const tab = () => window()?.tabs.find(item => item.id === tabID()) ?? window()?.tabs[0];
  const field = () => tab()?.fields.find(item => item.id === fieldID());
  const [references, { refetch: refreshReferences }] = createResource(() => open() && can('cpe', 'read') ? { id: props.template.id, search: referenceSearch() } : false, query => api.getEditWindowReferences(query.id, query.search));
  const [parameters, { refetch: refreshParameters }] = createResource(() => open() && reference() && can('cpe', 'read') ? { id: props.template.id, serial: reference() } : false, query => api.getEditWindowParameters(query.id, query.serial));
  const referenceList = () => references.error ? [] : references.latest ?? [];
  const choices = () => (parameters.error ? [] : parameters.latest ?? []).filter(item => item.target === target() && (!window()?.base_pattern || item.base_pattern === window().base_pattern) && item.name.toLowerCase().includes(parameterSearch().toLowerCase()));
  const updateWindow = (patch: Partial<CPEEditWindow>) => setWindows(current => current.map(item => item.target === target() ? { ...item, ...patch } : item));
  const updateTab = (patch: Partial<CPEEditTab>) => updateWindow({ tabs: window().tabs.map(item => item.id === tab()?.id ? { ...item, ...patch } : item) });
  const updateField = (patch: Partial<CPEEditField>) => updateTab({ fields: tab()!.fields.map(item => item.id === fieldID() ? { ...item, ...patch } : item) });
  const move = <T,>(items: T[], from: number, to: number) => { const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; };
  const show = () => {
    const definitions = editWindowTargets.map(item => structuredClone(props.template.cpe_edit_windows?.find(window => window.target === item.value) ?? newCPEEditWindow(item.value)));
    setWindows(definitions); setInitial(JSON.stringify(definitions)); setTarget('wifi'); setTabID(''); setFieldID(''); setReference(''); setError(''); setOpen(true);
  };
  const close = async () => {
    if (saving()) return;
    if (dirty() && !await confirm({ title: 'Discard unsaved editor design?', description: 'The tab, field and option changes have not been saved to this template.', confirmLabel: 'Discard changes' })) return;
    setOpen(false);
  };
  createEffect(() => {
    if (!open()) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
    globalThis.window.addEventListener('beforeunload', beforeUnload);
    onCleanup(() => globalThis.window.removeEventListener('beforeunload', beforeUnload));
  });
  const addParameter = () => {
    const selected = choices().find(item => item.name === picked());
    if (!selected || !tab() || !editable()) return;
    if (window().tabs.some(item => item.fields.some(field => field.parameter === selected.parameter))) { setError('This parameter is already in the editor.'); return; }
    const next: CPEEditField = { id: crypto.randomUUID(), name: selected.parameter.split('.').at(-1) ?? selected.parameter, parameter: selected.parameter, type: selected.type, input: 'auto', span: 1, new_row: false, help: '', options: [] };
    const tabs = window().tabs.map(item => item.id === tab()!.id ? { ...item, fields: [...item.fields, next] } : item);
    updateWindow({ base_pattern: selected.base_pattern, tabs }); setFieldID(next.id); setPicked(''); setError('');
  };
  const rebind = (metadata: CPEEditParameterMetadata) => {
    if (window().tabs.some(item => item.fields.some(candidate => candidate.id !== fieldID() && candidate.parameter === metadata.parameter))) { setError('This parameter is already in the editor.'); return; }
    updateField({ parameter: metadata.parameter, type: metadata.type, input: 'auto', options: [] }); setError('');
  };
  const removeField = async () => {
    if (!field() || !editable()) return;
    if (!await confirm({ title: 'Remove this field?', description: 'This removes the field from the editor design. CPE parameter data is preserved.', confirmLabel: 'Remove field', tone: 'danger' })) return;
    updateTab({ fields: tab()!.fields.filter(item => item.id !== fieldID()) }); setFieldID('');
  };
  const reset = async () => {
    if (!editable() || !await confirm({ title: 'Reset this editor?', description: 'Remove its custom fields and restore the built-in form after saving.', confirmLabel: 'Reset editor', tone: 'danger' })) return;
    updateWindow(newCPEEditWindow(target())); setTabID(''); setFieldID(''); setPicked(''); setError('');
  };
  const save = async () => {
    if (!editable()) return;
    const definitions = windows().filter(item => item.enabled || item.tabs.some(tab => tab.fields.length));
    if (definitions.length && !reference()) { setError('Choose an online reference CPE to verify field types and writable status.'); return; }
    for (const definition of definitions) for (const item of definition.tabs) for (const value of item.fields) {
      if (!value.name.trim()) { setError('Every field needs a name.'); return; }
      if (value.input === 'select' && (!value.options.length || value.options.some(option => !option.label.trim() || validateCPEEditValue(value.type, option.value)))) { setError(`Check custom select options for ${value.name}. Values must match ${value.type}.`); return; }
    }
    setSaving(true); setError('');
    try {
      const result = await api.saveEditWindows(props.template.id, reference(), definitions);
      props.onSaved(result.cpe_edit_windows); setInitial(JSON.stringify(windows()));
      notify({ tone: 'success', title: 'Edit windows saved', message: 'Enabled definitions are used by matching CPE interface editors.' });
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  const dropTab = (event: DragEvent, index: number) => {
    event.preventDefault(); if (!editable()) return;
    const id = event.dataTransfer?.getData('text/plain'); const from = window().tabs.findIndex(item => `tab:${item.id}` === id);
    if (from >= 0) updateWindow({ tabs: move(window().tabs, from, index) });
  };
  const dropField = (event: DragEvent, index: number) => {
    event.preventDefault(); if (!editable() || !tab()) return;
    const id = event.dataTransfer?.getData('text/plain'); const from = tab()!.fields.findIndex(item => `field:${item.id}` === id);
    if (from >= 0) updateTab({ fields: move(tab()!.fields, from, index) });
  };
  return <section class="space-y-3" aria-label="CPE edit window designer">
    <p class="text-xs text-muted">Define model-specific WAN, LAN and Wi-Fi editors. Parameters bind to the opened interface, so instance numbers can differ between CPEs. Disabled editors use the built-in form.</p>
    <button type="button" class="btn btn-primary" onClick={show}>Open edit window designer</button>
    <Show when={open()}><Dialog title={`Edit windows — ${props.template.name}`} description="Build tabs and fields using writable parameters from a matching online CPE. Preview does not change the CPE." size="large" onClose={() => void close()} actions={<><span class="text-xs text-muted mr-auto">{dirty() ? 'Unsaved design changes' : 'Design saved'}</span><button type="button" class="btn btn-secondary" disabled={saving()} onClick={() => void close()}>Close</button><Show when={can('settings.provisioning', 'write')}><button type="button" class="btn btn-primary" disabled={saving() || !dirty()} onClick={() => void save()}><Save size={14} aria-hidden="true" />{saving() ? 'Saving…' : 'Save design'}</button></Show></>}>
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="text-xs text-muted">Find reference CPE by serial<input class="input w-full mt-1" value={referenceSearch()} disabled={!can('cpe', 'read') || saving()} onInput={event => setReferenceSearch(event.currentTarget.value)} /></label>
          <label class="text-xs text-muted">Online reference CPE<select class="input w-full mt-1" value={reference()} disabled={!can('cpe', 'read') || references.loading || saving()} onChange={event => { setReference(event.currentTarget.value); setPicked(''); }}><option value="">Choose a matching CPE</option><Show when={reference() && !referenceList().some(item => item.serial === reference())}><option value={reference()}>{reference()}</option></Show><Index each={referenceList()}>{item => <option value={item().serial}>{item().serial}</option>}</Index></select></label>
        </div>
        <p class="text-xs text-muted">Reference results are limited to 200 online CPEs using this exact template. Search by serial to narrow the list. Only confirmed writable parameters with a supported type are offered; values are never copied into the design.</p>
        <Show when={!can('cpe', 'read')}><p class="text-xs text-warning">CPE overview Read is required to browse a reference CPE.</p></Show>
        <Show when={references.error}><ResourceError title="Reference CPEs unavailable" description="Retry loading the matching online CPE list." onRetry={() => void refreshReferences()} /></Show>
        <Show when={parameters.error}><ResourceError title="Reference parameters unavailable" description="The CPE may be offline or no longer use this template. Retry or choose another reference." onRetry={() => void refreshParameters()} /></Show>
        <div class="flex flex-wrap items-end gap-3">
          <label class="text-xs text-muted">Editor<select class="input mt-1" value={target()} disabled={saving()} onChange={event => { setTarget(event.currentTarget.value as CPEEditTarget); setTabID(''); setFieldID(''); setPicked(''); }}><Index each={editWindowTargets}>{item => <option value={item().value}>{item().label}</option>}</Index></select></label>
          <label class="flex items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={window()?.enabled} disabled={!editable()} onChange={event => updateWindow({ enabled: event.currentTarget.checked })} />Use custom editor for this template</label>
          <button type="button" class="btn btn-secondary" disabled={!editable()} onClick={() => void reset()}>Reset to built-in</button>
        </div>
        <p class="text-xs text-muted font-mono break-all">Interface binding: {window()?.base_pattern || 'Select the first writable parameter to establish the interface model.'}</p>
        <div class="grid grid-cols-1 lg:grid-cols-[12rem_minmax(0,1fr)] gap-4">
          <section class="border border-subtle p-3 space-y-2" aria-label="Editor tabs">
            <h3 class="text-sm font-medium text-primary">Tabs</h3>
            <Index each={window()?.tabs}>{(item, index) => <div class="space-y-1 border border-subtle p-2" onDragOver={event => event.preventDefault()} onDrop={event => dropTab(event, index)}>
              <button type="button" class={`btn w-full ${tab()?.id === item().id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setTabID(item().id); setFieldID(''); }}>{item().name || 'Unnamed tab'}</button>
              <div class="flex gap-1"><button type="button" class="icon-button" draggable={editable()} aria-label={`Drag tab ${item().name}`} disabled={!editable()} onDragStart={event => event.dataTransfer?.setData('text/plain', `tab:${item().id}`)}>↕</button><button type="button" class="icon-button" aria-label={`Move tab ${item().name} up`} disabled={!editable() || index === 0} onClick={() => updateWindow({ tabs: move(window().tabs, index, index - 1) })}><ArrowUp size={13} /></button><button type="button" class="icon-button" aria-label={`Move tab ${item().name} down`} disabled={!editable() || index === window().tabs.length - 1} onClick={() => updateWindow({ tabs: move(window().tabs, index, index + 1) })}><ArrowDown size={13} /></button></div>
            </div>}</Index>
            <button type="button" class="btn btn-secondary w-full" disabled={!editable() || window()?.tabs.length >= 8} onClick={() => { const next: CPEEditTab = { id: crypto.randomUUID(), name: 'New tab', columns: 2, fields: [] }; updateWindow({ tabs: [...window().tabs, next] }); setTabID(next.id); setFieldID(''); }}><Plus size={14} aria-hidden="true" />Add tab</button>
          </section>
          <section class="space-y-4" aria-label="Tab design">
            <Show when={tab()}>{current => <>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label class="text-xs text-muted">Tab name<input class="input mt-1 w-full" maxlength={80} value={current().name} disabled={!editable()} onInput={event => updateTab({ name: event.currentTarget.value })} /></label>
                <label class="text-xs text-muted">Columns<select class="input mt-1 w-full" value={current().columns} disabled={!editable()} onChange={event => { const columns = Number(event.currentTarget.value); updateTab({ columns, fields: current().fields.map(field => ({ ...field, span: Math.min(field.span, columns) })) }); }}><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
                <button type="button" class="btn btn-secondary self-end" disabled={!editable() || window().tabs.length === 1} onClick={async () => { if (await confirm({ title: 'Remove tab?', description: 'The tab and its fields will be removed from this editor design.', confirmLabel: 'Remove tab', tone: 'danger' })) { updateWindow({ tabs: window().tabs.filter(item => item.id !== current().id) }); setTabID(''); setFieldID(''); } }}>Remove tab</button>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label class="text-xs text-muted">Find writable parameter<input class="input mt-1 w-full" value={parameterSearch()} disabled={!editable()} onInput={event => setParameterSearch(event.currentTarget.value)} /></label>
                <label class="text-xs text-muted">Parameter from reference<select class="input mt-1 w-full font-mono" value={picked()} disabled={!editable() || !reference() || parameters.loading || !!parameters.error} onChange={event => setPicked(event.currentTarget.value)}><option value="">Choose a writable parameter</option><Index each={choices().slice(0, 200)}>{item => <option value={item().name}>{item().name} ({item().type})</option>}</Index></select></label>
              </div>
              <div class="flex flex-wrap items-center gap-2"><button type="button" class="btn btn-secondary" disabled={!editable() || !picked() || window().tabs.reduce((sum, item) => sum + item.fields.length, 0) >= 128} onClick={addParameter}><Plus size={14} aria-hidden="true" />Add field</button><span class="text-xs text-muted">{choices().length} matching paths; first 200 shown. Refine the search as needed.</span></div>
              <div class="space-y-2"><Index each={current().fields}>{(item, index) => <div class="flex flex-wrap items-center gap-2 border border-subtle p-2" onDragOver={event => event.preventDefault()} onDrop={event => dropField(event, index)}>
                <button type="button" class="icon-button" draggable={editable()} disabled={!editable()} aria-label={`Drag field ${item().name}`} onDragStart={event => event.dataTransfer?.setData('text/plain', `field:${item().id}`)}>↕</button>
                <button type="button" class={`btn min-w-0 flex-1 ${fieldID() === item().id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFieldID(item().id)}>{item().name || 'Unnamed field'}</button>
                <span class="text-xs text-muted font-mono break-all">{item().parameter}</span>
                <button type="button" class="icon-button" disabled={!editable() || index === 0} aria-label={`Move field ${item().name} up`} onClick={() => updateTab({ fields: move(current().fields, index, index - 1) })}><ArrowUp size={13} /></button><button type="button" class="icon-button" disabled={!editable() || index === current().fields.length - 1} aria-label={`Move field ${item().name} down`} onClick={() => updateTab({ fields: move(current().fields, index, index + 1) })}><ArrowDown size={13} /></button>
              </div>}</Index></div>
              <Show when={field()}>{selected => <fieldset class="space-y-3 border border-subtle p-3" disabled={!editable()}>
                <legend class="text-sm text-primary px-1">Field properties</legend>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label class="text-xs text-muted">Name<input class="input mt-1 w-full" maxlength={80} value={selected().name} onInput={event => updateField({ name: event.currentTarget.value })} /></label>
                  <label class="text-xs text-muted">Parameter name<select class="input mt-1 w-full font-mono" value={selected().parameter} disabled={!reference() || parameters.loading || !!parameters.error} onChange={event => { const metadata = choices().find(item => item.parameter === event.currentTarget.value); if (metadata) rebind(metadata); }}><option value={selected().parameter}>{selected().parameter}</option><Index each={choices().filter((item, index, all) => item.parameter !== selected().parameter && all.findIndex(other => other.parameter === item.parameter) === index).slice(0, 200)}>{item => <option value={item().parameter}>{item().parameter}</option>}</Index></select></label>
                  <label class="text-xs text-muted">CWMP type (automatic)<input class="input mt-1 w-full" readonly value={selected().type} /></label>
                  <label class="text-xs text-muted">Field type<select class="input mt-1 w-full" value={selected().input} onChange={event => updateField({ input: event.currentTarget.value as 'auto' | 'select', options: event.currentTarget.value === 'auto' ? [] : selected().options })}><option value="auto">Automatic ({editFieldInput({ ...selected(), input: 'auto' })})</option><option value="select" disabled={editFieldSensitive(selected().parameter)}>Custom select</option></select></label>
                  <label class="text-xs text-muted">Column span<select class="input mt-1 w-full" value={selected().span} onChange={event => updateField({ span: Number(event.currentTarget.value) })}><Index each={Array.from({ length: current().columns }, (_, index) => index + 1)}>{span => <option value={span()}>{span()}</option>}</Index></select></label>
                  <label class="flex items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={selected().new_row} onChange={event => updateField({ new_row: event.currentTarget.checked })} />Start a new row</label>
                </div>
                <label class="block text-xs text-muted">Help text<textarea class="input mt-1 w-full" rows={2} maxlength={1024} value={selected().help} onInput={event => updateField({ help: event.currentTarget.value })} /></label>
                <Show when={selected().input === 'select'}><div class="space-y-2"><p class="text-xs text-muted">Custom select options: label shown to the operator and exact {selected().type} value sent to the CPE. Existing values outside this list are displayed without being overwritten.</p>
                  <Index each={selected().options}>{(option, index) => <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                    <label class="text-xs text-muted">Label<input class="input mt-1 w-full" maxlength={128} value={option().label} onInput={event => updateField({ options: selected().options.map((item, position) => position === index ? { ...item, label: event.currentTarget.value } : item) })} /></label>
                    <label class="text-xs text-muted">Value<input class="input mt-1 w-full font-mono" maxlength={1024} value={option().value} onInput={event => updateField({ options: selected().options.map((item, position) => position === index ? { ...item, value: event.currentTarget.value } : item) })} /></label>
                    <button type="button" class="icon-button self-end" aria-label={`Remove option ${index + 1}`} onClick={() => updateField({ options: selected().options.filter((_, position) => position !== index) })}><Trash2 size={14} /></button>
                  </div>}</Index>
                  <button type="button" class="btn btn-secondary" disabled={selected().options.length >= 64} onClick={() => updateField({ options: [...selected().options, { label: '', value: '' }] })}>Add option</button>
                </div></Show>
                <button type="button" class="btn btn-secondary text-error" onClick={() => void removeField()}>Remove field</button>
              </fieldset>}</Show>
              <section class="border border-subtle p-3 space-y-3" aria-label="Editor preview"><h3 class="text-sm text-primary">Preview — {current().name}</h3><CPEEditWindowFields tab={current()} prefix="" parameters={[]} edits={{}} editable={false} preview onChange={() => {}} /><Show when={!current().fields.length}><p class="text-xs text-muted">Add writable parameters to preview this tab.</p></Show></section>
            </>}</Show>
          </section>
        </div>
        <Show when={error()}><p class="text-xs text-error" role="alert">{error()}</p></Show>
      </div>
    </Dialog></Show>
  </section>;
};

export default CPEEditWindowDesigner;
