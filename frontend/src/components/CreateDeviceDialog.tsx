import { createMemo, createResource, createSignal, For, Show, type Component } from 'solid-js';
import { api, type Device } from '../lib/api';
import Dialog from './Dialog';

const CreateDeviceDialog: Component<{ canAutoFactoryReset: boolean; requiresTOTP: boolean; onClose: () => void; onCreated: (device: Device) => void }> = (props) => {
  const [serial, setSerial] = createSignal('');
  const [selectedTags, setSelectedTags] = createSignal<string[]>([]);
  const [tagSearch, setTagSearch] = createSignal('');
  const [factoryReset, setFactoryReset] = createSignal(false);
  const [currentPassword, setCurrentPassword] = createSignal('');
  const [totpCode, setTotpCode] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [tags, { refetch }] = createResource(api.getTags);
  const visibleTags = createMemo(() => (tags() || []).filter(tag => tag.name.toLocaleLowerCase().includes(tagSearch().trim().toLocaleLowerCase())));
  const close = () => { if (!saving()) props.onClose(); };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving() || tags.loading || tags.error) return;
    const serialNumber = serial().trim();
    if (!serialNumber || new TextEncoder().encode(serialNumber).length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(serialNumber)) {
      setError('Enter a serial number of at most 128 bytes without control characters.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const device = await api.createDevice({ serial_number: serialNumber, tags: selectedTags(), factory_reset_on_first_inform: factoryReset(), ...(factoryReset() ? props.requiresTOTP ? { totp_code: totpCode() } : { current_password: currentPassword() } : {}) });
      props.onCreated(device);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog title="Add CPE" size="small" onClose={close}
    description="Reserve a serial number before the CPE connects. Its first CWMP Inform will update this record and keep the assigned tags."
    actions={<>
      <button type="button" class="btn btn-secondary" onClick={close} disabled={saving()}>Cancel</button>
      <button type="submit" form="create-cpe-form" class="btn btn-primary" disabled={saving() || tags.loading || Boolean(tags.error)}>{saving() ? 'Adding…' : 'Add CPE'}</button>
    </>}>
    <form id="create-cpe-form" class="space-y-4" onSubmit={submit}>
      <label for="create-cpe-serial" class="block text-xs text-secondary">Serial number
        <input id="create-cpe-serial" class="input mt-1.5 w-full font-mono" value={serial()} onInput={event => setSerial(event.currentTarget.value)} required maxlength="128" autocomplete="off" autocapitalize="off" spellcheck={false} disabled={saving()} aria-describedby="create-cpe-serial-help" autofocus />
      </label>
      <p id="create-cpe-serial-help" class="text-xs text-muted">Enter the exact serial number reported by the CPE, including letter case.</p>
      <Show when={props.canAutoFactoryReset}>
        <fieldset class="space-y-3 rounded border border-subtle p-3" disabled={saving()}>
          <label class="flex min-h-11 items-center gap-2 text-sm text-primary"><input type="checkbox" checked={factoryReset()} onChange={event => { setFactoryReset(event.currentTarget.checked); setError(''); }} />Factory reset on first CWMP Inform</label>
          <Show when={factoryReset()}>
            <div class="space-y-3 rounded border border-warning/30 bg-warning/5 p-3">
              <p class="text-xs text-warning">This erases the CPE configuration. The reset is sent only during the first CWMP session; provisioning waits for the next Inform. Re-enter your credentials to arm it.</p>
              <Show when={props.requiresTOTP} fallback={<label class="block text-xs text-secondary">Current ACS account password<input type="password" class="input mt-1.5 w-full" autocomplete="current-password" required value={currentPassword()} onInput={event => setCurrentPassword(event.currentTarget.value)} /></label>}>
                <label class="block text-xs text-secondary">Authenticator code<input type="text" inputmode="numeric" maxlength="7" autocomplete="one-time-code" class="input mt-1.5 w-full font-mono" required value={totpCode()} onInput={event => setTotpCode(event.currentTarget.value)} /></label>
              </Show>
            </div>
          </Show>
        </fieldset>
      </Show>
      <fieldset disabled={saving()} class="space-y-2">
        <legend class="text-xs text-secondary">Tags (optional) · {selectedTags().length}/32 selected</legend>
        <Show when={tags.loading}><p class="text-xs text-muted" role="status">Loading tags…</p></Show>
        <Show when={tags.error}><div role="alert" class="text-sm text-error">Tags could not be loaded. <button type="button" class="btn btn-secondary text-xs" onClick={() => void refetch()}>Retry</button></div></Show>
        <Show when={!tags.loading && !tags.error}>
          <Show when={tags()?.length} fallback={<p class="text-xs text-muted">No tags are defined. Add tags in System settings → Dictionaries.</p>}>
            <label for="create-cpe-tag-search" class="sr-only">Search tags</label>
            <input id="create-cpe-tag-search" class="input w-full" placeholder="Search tags…" value={tagSearch()} onInput={event => setTagSearch(event.currentTarget.value)} />
            <div class="max-h-52 overflow-y-auto rounded border border-subtle bg-base p-2">
              <For each={visibleTags()}>{tag => <label class="flex min-h-11 items-center gap-2 px-2 text-sm text-primary">
                <input type="checkbox" checked={selectedTags().includes(tag.id)} disabled={!selectedTags().includes(tag.id) && selectedTags().length >= 32} onChange={event => setSelectedTags(previous => event.currentTarget.checked ? [...previous, tag.id] : previous.filter(id => id !== tag.id))} />
                <span class="min-w-0 break-words">{tag.name}</span>
              </label>}</For>
              <Show when={visibleTags().length === 0}><p class="py-2 text-xs text-muted">No matching tags.</p></Show>
            </div>
          </Show>
        </Show>
      </fieldset>
      <p class="text-xs text-muted"><span class="badge badge-warning">Waiting</span> until the first CWMP Inform arrives.</p>
      <Show when={error()}><p class="text-sm text-error" role="alert">{error()}</p></Show>
    </form>
  </Dialog>;
};

export default CreateDeviceDialog;
