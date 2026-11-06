import { createContext, createMemo, createSignal, createUniqueId, createComponent, Index, onCleanup, onMount, Show, splitProps, useContext, type Component, type ComponentProps, type JSX } from 'solid-js';
import { CircleHelp, X } from 'lucide-solid';
import { Dynamic } from 'solid-js/web';
import Dialog from './Dialog';

export interface FieldHelpTopic {
  title: string;
  paragraphs: string[];
  example?: string;
  content?: Component;
}

const HelpContext = createContext<{
  topics: Record<string, FieldHelpTopic>;
  selected: () => string;
  desktop: () => boolean;
  panelID: string;
  toggle: (key: string, trigger: HTMLButtonElement) => void;
}>();

export const HelpLabel: Component<JSX.LabelHTMLAttributes<HTMLLabelElement> & { help?: string; as?: 'label' | 'span' }> = props => {
  const context = useContext(HelpContext);
  const [local, label] = splitProps(props, ['help', 'children', 'as']);
  const key = () => local.help ?? props.for ?? '';
  const layout = () => (props.class ?? '').split(' ').filter(value => /^(?:\w+:)?(?:col-span-|w-|shrink-|flex-)/.test(value)).join(' ');
  return <Show when={context?.topics[key()]} fallback={<Dynamic component={local.as ?? 'label'} {...label}>{local.children}</Dynamic>}>
    <div class={layout()}><div class="flex items-start gap-1">
      <Dynamic component={local.as ?? 'label'} {...label} class={`${props.class ?? ''} min-w-0 flex-1`}>{local.children}</Dynamic>
      <button type="button" class="icon-button shrink-0" aria-label={`Help: ${context!.topics[key()].title}`} data-help-topic={key()}
        aria-haspopup={context!.desktop() ? undefined : 'dialog'} aria-expanded={context!.selected() === key()}
        aria-controls={context!.desktop() && context!.selected() === key() ? context!.panelID : undefined}
        onClick={event => context!.toggle(key(), event.currentTarget)}><CircleHelp size={14} aria-hidden="true" /></button>
    </div></div>
  </Show>;
};

const FieldHelpDialog: Component<ComponentProps<typeof Dialog> & { topics: Record<string, FieldHelpTopic> }> = props => {
  const [local, dialog] = splitProps(props, ['topics', 'children']);
  const [selected, setSelected] = createSignal('');
  const [desktop, setDesktop] = createSignal(window.matchMedia('(min-width: 1024px)').matches);
  const panelID = createUniqueId();
  const showSidePanel = createMemo(() => desktop() && selected() !== '');
  let trigger: HTMLButtonElement | undefined;
  const close = () => {
    setSelected('');
    queueMicrotask(() => { if (trigger?.isConnected) trigger.focus(); });
  };
  const toggle = (key: string, button: HTMLButtonElement) => {
    trigger = button;
    if (selected() === key) close(); else setSelected(key);
  };
  onMount(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setDesktop(media.matches);
    media.addEventListener('change', update);
    onCleanup(() => media.removeEventListener('change', update));
  });
  const content = () => <div class="space-y-4 text-sm text-secondary">
    <div><label for={`${panelID}-field`} class="block text-xs text-muted mb-1">Field</label>
      <select id={`${panelID}-field`} class="input w-full" value={selected()} onChange={event => setSelected(event.currentTarget.value)}>
        <Index each={Object.entries(local.topics)}>{entry => <option value={entry()[0]}>{entry()[1].title}</option>}</Index>
      </select>
    </div>
    <Show when={local.topics[selected()]}>{topic => <>
      <h3 class="text-sm font-semibold text-primary">{topic().title}</h3>
      <Index each={topic().paragraphs}>{paragraph => <p>{paragraph()}</p>}</Index>
      <Show when={topic().example}><div><p class="text-xs text-muted mb-1">Example</p><pre class="font-mono text-xs whitespace-pre-wrap break-words border border-subtle p-3">{topic().example}</pre></div></Show>
      <Show when={topic().content}>{component => createComponent(component(), {})}</Show>
    </>}</Show>
  </div>;
  const sidePanel = () => showSidePanel() ? <aside id={panelID} class="dialog-side-panel" aria-label="Field help" on:keydown={(event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <header class="dialog-header"><div class="dialog-header-content"><h2>Field help</h2></div><button type="button" class="icon-button" onClick={close} aria-label="Close field help"><X size={17} aria-hidden="true" /></button></header>
    <div class="dialog-body" tabindex="0" role="region" aria-label="Field help reference">{content()}</div>
  </aside> : undefined;
  return <HelpContext.Provider value={{ get topics() { return local.topics; }, selected, desktop, panelID, toggle }}>
    <Dialog {...dialog} sidePanel={sidePanel()}>
      <div class="flex justify-end mb-3"><button type="button" class="btn btn-secondary" aria-expanded={!!selected()} onClick={event => { trigger = event.currentTarget; if (selected()) close(); else setSelected(Object.keys(local.topics)[0]); }}><CircleHelp size={14} aria-hidden="true" />Field help</button></div>
      {local.children}
    </Dialog>
    <Show when={selected() && !desktop()}><Dialog title="Field help" size="large" onClose={close} actions={<button type="button" class="btn btn-secondary" onClick={close}>Close help</button>}>{content()}</Dialog></Show>
  </HelpContext.Provider>;
};

export default FieldHelpDialog;
