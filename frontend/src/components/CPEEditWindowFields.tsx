import { Index, Show, createUniqueId, type Component } from 'solid-js';
import type { CPEEditTab, DeviceParameter } from '../lib/api';
import { editFieldInput, editFieldSensitive, editFieldUnavailable } from '../lib/cpeEditWindows';

const CPEEditWindowFields: Component<{
  tab: CPEEditTab; prefix: string; parameters: DeviceParameter[]; edits: Record<string, string>;
  editable: boolean; preview?: boolean; errors?: Record<string, string>; onChange: (path: string, value: string) => void;
}> = props => {
  const id = createUniqueId();
  const columns = () => ({ 1: 'grid-cols-1', 2: 'grid-cols-1 md:grid-cols-2', 3: 'grid-cols-1 md:grid-cols-3', 4: 'grid-cols-1 md:grid-cols-4' }[props.tab.columns] ?? 'grid-cols-1');
  return <div class={`grid gap-4 ${columns()}`}><Index each={props.tab.fields}>{field => {
    const path = () => props.prefix + field().parameter;
    const parameter = () => props.parameters.find(item => item.name === path());
    const reason = () => props.preview ? '' : editFieldUnavailable(field(), parameter());
    const value = () => props.edits[path()] ?? (editFieldSensitive(path()) ? '' : parameter()?.value ?? '');
    const type = () => editFieldInput(field());
    const disabled = () => props.preview || !props.editable || !!reason();
    const span = () => ({ 1: '', 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4' }[Math.min(field().span, props.tab.columns)] ?? '');
    return <div class={`min-w-0 ${span()} ${field().new_row ? 'md:col-start-1' : ''}`}>
      <label for={`${id}-${field().id}`} class="block text-xs text-muted mb-1">{field().name}</label>
      <Show when={type() === 'select'} fallback={<Show when={type() === 'checkbox'} fallback={
        <input id={`${id}-${field().id}`} class="input w-full" type={type()} step={type() === 'number' ? 1 : undefined} min={field().type === 'unsignedInt' ? 0 : field().type === 'int' ? -2147483648 : undefined} max={field().type === 'unsignedInt' ? 4294967295 : field().type === 'int' ? 2147483647 : undefined} inputmode={type() === 'number' ? 'numeric' : undefined} autocomplete="off" value={value()} disabled={disabled()} aria-invalid={!!props.errors?.[path()]} placeholder={editFieldSensitive(path()) ? 'Leave unchanged' : props.preview ? field().parameter : ''} onInput={event => props.onChange(path(), event.currentTarget.value)} />
      }><div class="flex items-center gap-2"><input id={`${id}-${field().id}`} type="checkbox" checked={value() === 'true' || value() === '1'} ref={input => { input.indeterminate = !['true', 'false', '1', '0'].includes(value()); }} disabled={disabled()} onChange={event => props.onChange(path(), event.currentTarget.checked ? 'true' : 'false')} /><span class="text-xs text-secondary">{['true', '1'].includes(value()) ? 'True' : ['false', '0'].includes(value()) ? 'False' : 'Unknown'}</span></div></Show>}>
        <select id={`${id}-${field().id}`} class="input w-full" value={value()} disabled={disabled()} aria-invalid={!!props.errors?.[path()]} onChange={event => props.onChange(path(), event.currentTarget.value)}>
          <Show when={!field().options.some(option => option.value === value())}><option value={value()} disabled>{props.preview ? 'Select an option' : value() ? `Current: ${value()} (not configured)` : 'No current value'}</option></Show>
          <Index each={field().options}>{option => <option value={option().value}>{option().label}</option>}</Index>
        </select>
      </Show>
      <Show when={field().help}><p class="mt-1 text-xs text-muted">{field().help}</p></Show>
      <Show when={reason()}><p class="mt-1 text-xs text-warning">{reason()}</p></Show>
      <Show when={props.errors?.[path()]}><p class="mt-1 text-xs text-error" role="alert">{props.errors?.[path()]}</p></Show>
    </div>;
  }}</Index></div>;
};

export default CPEEditWindowFields;
