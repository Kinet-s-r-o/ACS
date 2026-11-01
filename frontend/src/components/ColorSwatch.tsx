import type { Component } from 'solid-js';
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Palette, X } from 'lucide-solid';

const PRESET_COLORS = [
  { value: '#ef4444', label: 'Red' }, { value: '#f97316', label: 'Orange' },
  { value: '#f59e0b', label: 'Amber' }, { value: '#eab308', label: 'Yellow' },
  { value: '#84cc16', label: 'Lime' }, { value: '#22c55e', label: 'Green' },
  { value: '#10b981', label: 'Emerald' }, { value: '#14b8a6', label: 'Teal' },
  { value: '#06b6d4', label: 'Cyan' }, { value: '#0ea5e9', label: 'Sky blue' },
  { value: '#3b82f6', label: 'Blue' }, { value: '#1d4ed8', label: 'Deep blue' },
  { value: '#075985', label: 'Deep cyan' }, { value: '#0f766e', label: 'Deep teal' },
  { value: '#d946ef', label: 'Fuchsia' }, { value: '#ec4899', label: 'Pink' },
  { value: '#f43f5e', label: 'Rose' }, { value: '#7c2d12', label: 'Brown' },
  { value: '#64748b', label: 'Slate' }, { value: '#94a3b8', label: 'Gray' },
  { value: '#38bdf8', label: 'Light blue' }, { value: '#a78bfa', label: 'Lavender' },
  { value: '#34d399', label: 'Mint' }, { value: '#fbbf24', label: 'Gold' },
  { value: '#f472b6', label: 'Light pink' }, { value: '#fb923c', label: 'Light orange' },
  { value: '#22d3ee', label: 'Light cyan' }, { value: '#a3e635', label: 'Light lime' },
  { value: '#e879f9', label: 'Light fuchsia' }, { value: '#2dd4bf', label: 'Light teal' },
  { value: '#2563eb', label: 'Bright blue' }, { value: '#cbd5e1', label: 'Light gray' },
];

interface ColorSwatchProps {
  value: string;
  onChange: (color: string) => void;
  compact?: boolean;
  clearable?: boolean;
  ariaLabel?: string;
}

const ColorSwatch: Component<ColorSwatchProps> = (props) => {
  const [hexInput, setHexInput] = createSignal(props.value);
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;

  createEffect(() => setHexInput(props.value));
  onMount(() => {
    if (!props.compact) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (open() && event.key === 'Escape') {
        setOpen(false);
        trigger?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    onCleanup(() => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    });
  });

  const selectColor = (color: string) => {
    setHexInput(color);
    props.onChange(color);
    setOpen(false);
    if (props.compact) trigger?.focus();
  };

  const handleHexInput = (val: string) => {
    setHexInput(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) props.onChange(val);
  };

  const clearColor = () => {
    setHexInput('');
    props.onChange('');
    setOpen(false);
  };

  const palette = () => <>
    <div class="flex flex-wrap gap-1.5" role="group" aria-label="Preset colors">
      {PRESET_COLORS.map(({ value, label }) => (
        <button
          type="button"
          onClick={() => selectColor(value)}
          class="color-swatch h-5 w-5 rounded-[3px] transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          data-dynamic-style="color-swatch"
          style={{ '--swatch-color': value, outline: props.value.toLowerCase() === value ? `2px solid ${value}` : undefined, 'outline-offset': '2px' } as any}
          aria-label={`Select ${label} color`}
          aria-pressed={props.value.toLowerCase() === value}
          title={label}
        />
      ))}
      <Show when={props.clearable !== false}>
        <button
          type="button"
          onClick={clearColor}
          class="flex h-5 w-5 items-center justify-center rounded-[3px] border border-subtle text-muted transition-colors hover:text-primary"
          aria-label="Clear color"
          title="Clear color"
        >
          <X size={10} />
        </button>
      </Show>
    </div>
    <label class="block text-xs text-muted">Custom color
      <input
        type="text"
        value={hexInput()}
        onInput={(event) => handleHexInput(event.currentTarget.value)}
        class="input mt-1 w-28 font-mono text-xs"
        placeholder="#hex"
        aria-label="Custom hex color"
        pattern="^#[0-9a-fA-F]{6}$"
      />
    </label>
  </>;

  return <div class={props.compact ? 'relative inline-block' : 'space-y-2'} ref={root}>
    <Show when={props.compact} fallback={palette()}>
      <button
        type="button"
        ref={trigger}
        class="icon-button h-8 w-9"
        aria-label={props.ariaLabel ?? 'Choose color'}
        aria-haspopup="dialog"
        aria-expanded={open()}
        title={props.ariaLabel ?? 'Choose color'}
        onClick={() => setOpen((current) => !current)}
      >
        <span class="color-swatch h-3.5 w-3.5 rounded-sm" data-dynamic-style="color-swatch" style={{ '--swatch-color': props.value || 'transparent' } as any} />
        <Palette size={14} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-full z-50 mt-1 w-64 space-y-2 rounded border border-subtle bg-elevated p-2 shadow-xl" role="dialog" aria-label="Choose color">
          {palette()}
        </div>
      </Show>
    </Show>
  </div>;
};

export default ColorSwatch;
