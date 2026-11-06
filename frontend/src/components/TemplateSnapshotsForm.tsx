import type { Component } from 'solid-js';
import type { TemplateSnapshotSettings } from '../lib/api';

const TemplateSnapshotsForm: Component<{ value: TemplateSnapshotSettings; disabled: boolean; onChange: (value: TemplateSnapshotSettings) => void }> = props => {
  const update = (patch: Partial<TemplateSnapshotSettings>) => props.onChange({ ...props.value, ...patch });
  return <fieldset disabled={props.disabled} class="space-y-5">
    <section class="space-y-3" aria-label="Initial snapshot settings">
      <label class="flex items-center gap-2 text-sm text-primary"><input type="checkbox" checked={props.value.initial_enabled} onChange={event => update({ initial_enabled: event.currentTarget.checked })} />Initial snapshot</label>
      <label for="snapshot-initial-delay" class="block text-xs text-muted">Delay after adding a new ONT (minutes)</label>
      <input id="snapshot-initial-delay" type="number" class="input w-full" min={0} max={525600} step={1} required disabled={!props.value.initial_enabled} value={props.value.initial_delay_minutes} onInput={event => update({ initial_delay_minutes: event.currentTarget.valueAsNumber })} />
      <p class="text-xs text-muted">Checked every 15 minutes. Applies to ONTs added after initial snapshots were enabled. Zero means eligible immediately. The ACS summons the ONT, waits for a successful parameter refresh and then creates one initial snapshot. Failed contacts retry on a later check.</p>
      <p class="text-xs text-muted">Initial snapshots are protected from retention cleanup and deletion by CPE Write operators. Deletion requires CPE Full access.</p>
    </section>
    <section class="space-y-3 border-t border-subtle pt-4" aria-label="Scheduled snapshot settings">
      <label class="flex items-center gap-2 text-sm text-primary"><input type="checkbox" checked={props.value.scheduled_enabled} onChange={event => update({ scheduled_enabled: event.currentTarget.checked })} />Scheduled snapshots</label>
      <label for="snapshot-scheduled-interval" class="block text-xs text-muted">Snapshot interval (minutes)</label>
      <input id="snapshot-scheduled-interval" type="number" class="input w-full" min={1} max={525600} step={1} required disabled={!props.value.scheduled_enabled} value={props.value.scheduled_interval_minutes} onInput={event => update({ scheduled_interval_minutes: event.currentTarget.valueAsNumber })} />
      <p class="text-xs text-muted">Checked every 5 minutes. Due times are PeriodicInformTime + N × interval, using the stored InternetGatewayDevice.ManagementServer.PeriodicInformTime value. Missing, invalid or unknown times pause scheduling for that ONT.</p>
      <p class="text-xs text-muted">Each due snapshot uses summon with a parameter refresh. Completion depends on the ONT responding. Missed intervals produce one snapshot for the latest due time, without a backlog. Disabling snapshots stops new jobs and prevents queued jobs from saving snapshots.</p>
    </section>
  </fieldset>;
};

export default TemplateSnapshotsForm;
