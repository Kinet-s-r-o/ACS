export const latestParameterTimestamp = (...values: (string | null | undefined)[]): string | null => {
  let latest: string | null = null;
  let latestTime = -Infinity;
  for (const value of values) {
    const time = value ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && time > latestTime) { latest = value!; latestTime = time; }
  }
  return latest;
};

export function hostParameterUpdates(parameters: { name: string; updated_at?: string }[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const parameter of parameters) {
    const prefix = parameter.name.match(/^(?:InternetGatewayDevice|Device)\.LANDevice\.\d+\.(?:Hosts\.Host\.\d+|WLANConfiguration\.\d+\.AssociatedDevice\.\d+)\./)?.[0];
    if (prefix) result.set(prefix, latestParameterTimestamp(result.get(prefix), parameter.updated_at));
  }
  return result;
}
