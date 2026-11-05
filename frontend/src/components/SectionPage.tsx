import type { ParentComponent } from 'solid-js';
import { Show } from 'solid-js';
import { useAuth, usePermissionSection } from '../lib/auth';
import { EmptyState } from './ResourceState';

const SectionPage: ParentComponent<{ section: string }> = props => {
  const { canVisit } = useAuth();
  usePermissionSection(() => props.section);
  return <Show when={canVisit(props.section)} fallback={<EmptyState title="Section access denied" description="Your role does not grant read access to this section or any of its tabs. Select an available section from the navigation." />}>{props.children}</Show>;
};
export default SectionPage;
