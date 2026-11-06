import type { TemplateSnapshotSettings } from './api';

export const defaultSnapshotSettings = (): TemplateSnapshotSettings => ({ initial_enabled: false, initial_delay_minutes: 0, scheduled_enabled: false, scheduled_interval_minutes: 1440 });

export function validateSnapshotSettings(settings: TemplateSnapshotSettings): string {
  if (![settings.initial_delay_minutes, settings.scheduled_interval_minutes].every(value => Number.isInteger(value) && value >= 0 && value <= 525600)) return 'Snapshot delays must be whole minutes between 0 and 525600.';
  if (settings.scheduled_enabled && settings.scheduled_interval_minutes < 1) return 'Scheduled snapshot interval must be at least 1 minute.';
  return '';
}

export const canDeleteSnapshot = (kind: string | undefined, write: boolean, full: boolean) => full || (kind !== 'initial' && write);
