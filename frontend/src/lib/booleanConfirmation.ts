import type { ConfirmOptions } from '../components/Feedback';

export const booleanChangePrompt = (label: string, current: boolean): ConfirmOptions => ({
  title: 'Confirm state change',
  description: `Change ${label} from ${current ? 'Yes' : 'No'} to ${current ? 'No' : 'Yes'}?`,
  confirmLabel: `Set to ${current ? 'No' : 'Yes'}`,
});

export async function confirmBooleanChange(confirm: (options: ConfirmOptions) => Promise<boolean>, options: ConfirmOptions, apply: () => unknown | Promise<unknown>): Promise<boolean> {
  if (!await confirm(options)) return false;
  await apply();
  return true;
}
