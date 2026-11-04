export function featureParameterUnavailableReason(parameter?: { writable?: boolean | null }): string {
  if (!parameter) return 'Parameter has not been reported by the device.';
  if (parameter.writable === false) return 'The device reports this parameter as read-only.';
  if (parameter.writable !== true) return 'Write access has not been reported by the device.';
  return '';
}
