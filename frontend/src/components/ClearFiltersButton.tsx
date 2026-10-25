import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { X } from 'lucide-solid';

interface ClearFiltersButtonProps {
  activeFilterCount: number;
  onClear: () => void;
}

const ClearFiltersButton: Component<ClearFiltersButtonProps> = (props) => (
  <Show when={props.activeFilterCount > 0}>
    <button type="button" class="clear-filters-button" onClick={props.onClear} title="Clear all filters" aria-label="Clear all filters">
      <X size={11} />
      <span>Clear filters</span>
    </button>
  </Show>
);

export default ClearFiltersButton;
