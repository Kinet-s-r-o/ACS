import { createEffect, createResource, onCleanup, onMount, Show, type Component } from 'solid-js';
import { api } from '../lib/api';
import { useFeedback } from './Feedback';
import { ResourceError } from './ResourceState';

const SnapshotRequestStatus: Component<{ taskID: number; onFinished: (success: boolean) => void }> = props => {
  const { notify } = useFeedback();
  const [task, { refetch }] = createResource(() => props.taskID, id => api.getSystemTask(id));
  const current = () => task.error ? undefined : task.latest;
  let finished = false;
  createEffect(() => {
    const state = current();
    if (finished || !state || (state.status !== 'completed' && state.status !== 'failed')) return;
    finished = true;
    const success = state.status === 'completed';
    notify(success ? { tone: 'success', title: 'Snapshot created after successful CPE refresh' } : { tone: 'error', title: 'Snapshot request failed', message: 'No snapshot was created.', detail: state.error_message, persistent: true });
    props.onFinished(success);
  });
  onMount(() => {
    const timer = window.setInterval(() => { if (!finished && !task.loading) void refetch(); }, 3000);
    onCleanup(() => window.clearInterval(timer));
  });
  return <div class="mb-3 space-y-2 text-xs text-muted" role="status">
    <p>Snapshot request #{props.taskID}: {current()?.status || 'loading'}. Waiting for a successful summon and parameter refresh through Bulk Summon.</p>
    <Show when={task.error}><ResourceError title="Could not read snapshot request status" description="The request remains in the queue. Retry checking its status." onRetry={() => void refetch()} /></Show>
  </div>;
};

export default SnapshotRequestStatus;
