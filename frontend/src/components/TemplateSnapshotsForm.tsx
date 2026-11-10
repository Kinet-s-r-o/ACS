import type { Component } from 'solid-js';
import type { TemplateSnapshotSettings } from '../lib/api';

const TemplateSnapshotsForm: Component<{ value: TemplateSnapshotSettings; disabled: boolean; onChange: (value: TemplateSnapshotSettings) => void }> = props => {
  const update = (patch: Partial<TemplateSnapshotSettings>) => props.onChange({ ...props.value, ...patch });
  return <fieldset disabled={props.disabled} class="space-y-5">
    <section class="space-y-3" aria-label="Initial snapshot settings">
      <label class="flex items-center gap-2 text-sm text-primary"><input type="checkbox" checked={props.value.initial_enabled} onChange={event => update({ initial_enabled: event.currentTarget.checked })} />Initial snapshot</label>
      <label for="snapshot-initial-delay" class="block text-xs text-muted">Delay after adding an ONT (minutes)</label>
      <input id="snapshot-initial-delay" type="number" class="input w-full" min={0} max={525600} step={1} required disabled={!props.value.initial_enabled} value={props.value.initial_delay_minutes} onInput={event => update({ initial_delay_minutes: event.currentTarget.valueAsNumber })} />
      <p class="text-xs text-muted">Checked on every CPE Inform. If no initial snapshot exists and the current time is at or after the ONT creation time plus this delay, the ACS queues a Summon. A snapshot is saved after successful Summon and parameter refresh. This includes older ONTs and deleted initial snapshots. Zero means eligible immediately; failed attempts retry on a later Inform.</p>
      <p class="text-xs text-muted">Initial snapshots are protected from retention cleanup and deletion by CPE Write operators. Deletion requires CPE Full access.</p>
      <p class="text-xs text-muted">Initial, Scheduled and Manual are separate snapshot types. Scheduled and Manual snapshots do not replace an Initial snapshot; its creation follows the Initial snapshot policy above.</p>
    </section>
    <section class="space-y-3 border-t border-subtle pt-4" aria-label="Scheduled snapshot settings">
      <label class="flex items-center gap-2 text-sm text-primary"><input type="checkbox" checked={props.value.scheduled_enabled} onChange={event => update({ scheduled_enabled: event.currentTarget.checked })} />Scheduled snapshots</label>
      <label for="snapshot-scheduled-interval" class="block text-xs text-muted">Snapshot interval (minutes)</label>
      <input id="snapshot-scheduled-interval" type="number" class="input w-full" min={1} max={525600} step={1} required disabled={!props.value.scheduled_enabled} value={props.value.scheduled_interval_minutes} onInput={event => update({ scheduled_interval_minutes: event.currentTarget.valueAsNumber })} />
      <p class="text-xs text-muted">Checked on every CPE Inform. When the current time is at or after the last Scheduled snapshot time plus this interval, the ACS queues a Summon with parameter refresh. If no Scheduled snapshot exists, the interval starts at the ONT creation time. Initial and Manual snapshots do not reset this interval.</p>
      <p class="text-xs text-muted">A Scheduled snapshot is saved after successful Summon and parameter refresh. The next interval starts from that successful snapshot. Active snapshot requests prevent duplicates; failed attempts retry on a later Inform. Disabling snapshots stops new jobs and prevents queued jobs from saving snapshots.</p>
    </section>
  </fieldset>;
};

export default TemplateSnapshotsForm;
