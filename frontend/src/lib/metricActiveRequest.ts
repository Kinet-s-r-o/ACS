import type { MetricDefinition } from './api';

export function metricActiveRequest(definition: MetricDefinition, active: boolean) {
  const { id, created_at, updated_at, ...settings } = definition;
  if (!settings.template_id) throw new Error('This metric must belong to a provisioning template.');
  const scope = settings.parameter_pattern ? 'interface-metrics' : 'metrics';
  return {
    endpoint: `/provisioning/templates/${settings.template_id}/${scope}/${id}`,
    body: { ...settings, active },
  };
}
