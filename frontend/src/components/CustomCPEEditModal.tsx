import { createMemo, createResource, createSignal, Index, Show, type Component, type JSX } from 'solid-js';
import { api, type CPEEditTarget } from '../lib/api';
import { validateCPEEditChanges } from '../lib/cpeEditWindows';
import { useAuth } from '../lib/auth';
import Dialog from './Dialog';
import CPEEditWindowFields from './CPEEditWindowFields';
import { ResourceError } from './ResourceState';
import { useFeedback } from './Feedback';

const CustomCPEEditModal: Component<{ serial: string; target: CPEEditTarget; prefix: string; fallback: JSX.Element; onClose: () => void; onSaved: () => void }> = props => {
  const { can } = useAuth();
  const { confirm, notify } = useFeedback();
  const [state, { refetch }] = createResource(() => ({ serial: props.serial, target: props.target, prefix: props.prefix }), query => api.getCPEEditWindow(query.serial, query.target, query.prefix));
  const [tabID, setTabID] = createSignal('');
  const [edits, setEdits] = createSignal<Record<string, string>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const currentTab = () => state()?.window?.tabs.find(tab => tab.id === tabID()) ?? state()?.window?.tabs[0];
  const result = createMemo(() => !state.error && state.latest?.window ? validateCPEEditChanges(state.latest.window, props.prefix, state.latest.parameters, edits()) : { changes: {}, errors: {} });
  const dirty = () => Object.keys(edits()).length > 0;
  const close = async () => {
    if (saving()) return;
    if (dirty() && !await confirm({ title: 'Discard unsaved interface changes?', description: 'The entered values have not been queued for the CPE.', confirmLabel: 'Discard changes' })) return;
    props.onClose();
  };
  const save = async () => {
    if (!can('cpe', 'write') || saving() || !state()?.window) return;
    setErrors(result().errors);
    if (Object.keys(result().errors).length) {
      const invalid = Object.keys(result().errors)[0];
      setTabID(state()!.window!.tabs.find(tab => tab.fields.some(field => props.prefix + field.parameter === invalid))?.id ?? '');
      return;
    }
    const changes = result().changes;
    if (!Object.keys(changes).length) return;
    if (!await confirm({ title: 'Queue interface changes?', description: `${Object.keys(changes).length} parameter change(s) will be applied when this CPE next connects.`, confirmLabel: 'Queue changes' })) return;
    setSaving(true);
    try {
      await api.applyCPEEditWindow(props.serial, props.target, props.prefix, changes);
      notify({ tone: 'success', title: 'Interface changes queued', message: 'The task will run in a subsequent CWMP session.' });
      setEdits({}); props.onSaved(); props.onClose();
    } catch (error) { notify({ tone: 'error', title: 'Could not queue changes', message: (error as Error).message, persistent: true }); }
    finally { setSaving(false); }
  };
  return <Show when={!state.loading} fallback={<Dialog title="Loading interface editor" onClose={props.onClose}><div class="skeleton h-48 w-full" /></Dialog>}>
    <Show when={!state.error} fallback={<Dialog title="Interface editor unavailable" onClose={props.onClose}><ResourceError title="Could not load this editor" description="Retry loading the template definition and current parameter metadata." onRetry={() => void refetch()} /></Dialog>}>
      <Show when={state()?.window} fallback={props.fallback}>{window => <Dialog title={`${window().target.replace('_', ' ').toUpperCase()} settings`} description={`Edit ${props.prefix}. Changes are queued and applied when the CPE next connects.`} size="large" onClose={() => void close()} actions={<><button type="button" class="btn btn-secondary" disabled={saving()} onClick={() => void close()}>Cancel</button><Show when={can('cpe', 'write')}><button type="button" class="btn btn-primary" disabled={saving() || !dirty()} onClick={() => void save()}>{saving() ? 'Queuing…' : 'Save changes'}</button></Show></>}>
        <div class="tab-bar mb-4" role="tablist" aria-label="Interface settings tabs"><Index each={window().tabs}>{tab => <button type="button" role="tab" class={`tab-btn ${currentTab()?.id === tab().id ? 'is-active' : ''}`} aria-selected={currentTab()?.id === tab().id} onClick={() => setTabID(tab().id)}>{tab().name}</button>}</Index></div>
        <Show when={currentTab()}>{tab => <CPEEditWindowFields tab={tab()} prefix={props.prefix} parameters={state()!.parameters} edits={edits()} errors={errors()} editable={can('cpe', 'write') && !saving()} onChange={(path, value) => { setEdits(current => ({ ...current, [path]: value })); setErrors({}); }} />}</Show>
      </Dialog>}</Show>
    </Show>
  </Show>;
};

export default CustomCPEEditModal;
