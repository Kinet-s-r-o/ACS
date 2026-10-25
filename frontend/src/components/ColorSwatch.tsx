import type { Component } from 'solid-js';
import { createSignal } from 'solid-js';
import { X } from 'lucide-solid';

const PRESET_COLORS = [
  '#38bdf8', '#a78bfa', '#34d399', '#fbbf24',
  '#f472b6', '#fb923c', '#22d3ee', '#a3e635',
  '#e879f9', '#2dd4bf', '#818cf8', '#94a3b8',
];

interface ColorSwatchProps {
  value: string;
  onChange: (color: string) => void;
}

const ColorSwatch: Component<ColorSwatchProps> = (props) => {
  const [hexInput, setHexInput] = createSignal(props.value);

  const selectColor = (color: string) => {
    setHexInput(color);
    props.onChange(color);
  };

  const handleHexInput = (val: string) => {
    setHexInput(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      props.onChange(val);
    }
  };

  const clearColor = () => {
    setHexInput('');
    props.onChange('');
  };

  return (
    <div class="space-y-2">
      <div class="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map((c) => (
          <button
            type="button"
            onClick={() => selectColor(c)}
            class="color-swatch w-5 h-5 rounded-[3px] transition-transform hover:scale-110"
            data-dynamic-style="color-swatch"
            style={{ '--swatch-color': c, outline: props.value === c ? `2px solid ${c}` : 'none', 'outline-offset': '2px' } as any}
            aria-label={`Select color ${c}`}
          />
        ))}
        <button
          type="button"
          onClick={clearColor}
          class="w-5 h-5 rounded-[3px] border border-subtle flex items-center justify-center text-muted hover:text-primary transition-colors"
          aria-label="Clear color"
        >
          <X size={10} />
        </button>
      </div>
      <input
        type="text"
        value={hexInput()}
        onInput={(e) => handleHexInput(e.currentTarget.value)}
        class="input w-24 font-mono text-xs"
        placeholder="#hex"
        aria-label="Custom hex color"
      />
    </div>
  );
};

export default ColorSwatch;
