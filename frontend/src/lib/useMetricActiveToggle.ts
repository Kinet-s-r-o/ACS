import { createSignal } from 'solid-js';
import { api, type MetricDefinition } from './api';
import { useAuth } from './auth';
import { useFeedback } from '../components/Feedback';

export function useMetricActiveToggle(refresh: (definition: MetricDefinition) => unknown | Promise<unknown>) {
  const { isFullAccess, hasAnyPermission } = useAuth();
  const { notify } = useFeedback();
  const [pending, setPending] = createSignal<number | null>(null);
  const canEdit = (definition: MetricDefinition) => !!definition.template_id && isFullAccess() && hasAnyPermission('provisioning.templates.write', 'provisioning.write');
  const toggle = async (definition: MetricDefinition) => {
    if (!canEdit(definition) || pending() !== null) return;
    setPending(definition.id);
    try {
      await api.setMetricActive(definition, !definition.active);
      await refresh(definition);
      notify({ tone: 'success', title: `Metric ${definition.active ? 'deactivated' : 'activated'}`, message: definition.name });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not update or refresh metric state', message: 'Refresh the list to verify the current state.', detail: (error as Error).message, persistent: true });
    } finally { setPending(null); }
  };
  return { canEdit, pending, toggle };
}
