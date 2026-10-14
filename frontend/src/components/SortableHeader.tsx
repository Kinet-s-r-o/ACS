import type { Component, JSX } from 'solid-js';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-solid';
import type { SortDirection } from '../lib/sorting';

const SortableHeader: Component<{ column: string; label: string; sortBy: string | null; direction: SortDirection; onSort: (column: string) => void; children?: JSX.Element; class?: string }> = (props) => (
  <div class={`flex items-center gap-1.5 ${props.class || ''}`}>
    <button type="button" class="inline-flex items-center gap-1 hover:text-primary" onClick={() => props.onSort(props.column)} aria-label={`Sort by ${props.label}`} aria-sort={props.sortBy === props.column ? (props.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {props.label}
      {props.sortBy === props.column ? (props.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} class="opacity-50" />}
    </button>
    {props.children}
  </div>
);

export default SortableHeader;
