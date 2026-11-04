import { createSignal, Show, type Component } from 'solid-js';

interface Props {
  value: boolean;
  label: string;
  editable?: boolean;
  disabled?: boolean;
  onToggle: () => Promise<unknown>;
}

const BooleanIndicator: Component<Props> = (props) => {
  const [pending, setPending] = createSignal(false);
  const toggle = async () => {
    if (!props.editable || props.disabled || pending()) return;
    setPending(true);
    try { await props.onToggle(); }
    finally { setPending(false); }
  };
  const badgeClass = () => `badge ${props.value ? 'badge-success' : 'badge-error'}`;
  return <Show when={props.editable} fallback={<span class={badgeClass()}>{props.value ? 'Yes' : 'No'}</span>}>
    <button type="button" class={`${badgeClass()} boolean-indicator`} aria-label={`Set ${props.label} to ${props.value ? 'No' : 'Yes'}`} aria-pressed={props.value} aria-busy={pending()} disabled={props.disabled || pending()} onClick={() => void toggle()}>
      {props.value ? 'Yes' : 'No'}
    </button>
  </Show>;
};

export default BooleanIndicator;
