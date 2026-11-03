export interface WanParameter {
  name: string;
  value: string;
  writable?: boolean;
}

export interface PortParams {
  lanEnablePaths?: Record<number, string>;
  ssidEnablePaths?: Record<number, string>;
}

export interface WanProfile {
  path: string;
  wanDevice: number;
  connectionDevice: number;
  instance: number;
  kind: 'WANPPPConnection' | 'WANIPConnection';
  canDeleteObject: boolean;
  name: string;
  status: string;
  enable: string;
  vlan: string;
  username: string;
  password: string;
  ipAddress: string;
  macAddress: string;
  service: string;
  nat: string;
  type: string;
  uptime: string;
  lan1: boolean;
  lan2: boolean;
  lan3: boolean;
  lan4: boolean;
  ssid1: boolean;
  ssid2: boolean;
  ssid3: boolean;
  ssid4: boolean;
  ssid5: boolean;
  ssid6: boolean;
  ssid7: boolean;
  ssid8: boolean;
  portParams?: PortParams;
}

const wanConnectionPattern = /^InternetGatewayDevice\.WANDevice\.(\d+)\.WANConnectionDevice\.(\d+)\.(WANPPPConnection|WANIPConnection)\.(\d+)(?:\.|$)/;

const enabled = (value: string) => ['1', 'true', 'enable', 'enabled', 'yes'].includes(value.toLowerCase());

export function getWanProfiles(parameters: WanParameter[]): WanProfile[] {
  const groups = new Map<string, { wanDevice: number; connectionDevice: number; instance: number; kind: string; own: WanParameter[] }>();

  for (const parameter of parameters) {
    const match = parameter.name.match(wanConnectionPattern);
    if (!match) continue;
    const [, wanDevice, connectionDevice, kind, instance] = match;
    const path = `InternetGatewayDevice.WANDevice.${wanDevice}.WANConnectionDevice.${connectionDevice}.${kind}.${instance}.`;
    if (!groups.has(path)) {
      groups.set(path, { wanDevice: Number(wanDevice), connectionDevice: Number(connectionDevice), instance: Number(instance), kind, own: [] });
    }
    groups.get(path)!.own.push(parameter);
  }

  const profiles = [...groups.entries()].sort(([, a], [, b]) =>
    a.wanDevice - b.wanDevice || a.connectionDevice - b.connectionDevice ||
    a.kind.localeCompare(b.kind) || a.instance - b.instance
  );

  return profiles.map(([path, group]) => {
    const parentPath = `InternetGatewayDevice.WANDevice.${group.wanDevice}.WANConnectionDevice.${group.connectionDevice}.`;
    const canDeleteObject = parameters.some(p => p.name === `${parentPath}${group.kind}.` && p.writable === true);
    const parent = parameters.filter(p => p.name.startsWith(parentPath) && !wanConnectionPattern.test(p.name));
    const relevant = [...group.own, ...parent];
    const ownValue = (name: string) => group.own.find(p => p.name === path + name)?.value || '-';
    const firstValue = (...names: string[]) => {
      for (const name of names) {
        const parameter = relevant.find(p => p.name.endsWith(`.${name}`) || p.name.includes(name));
        if (parameter?.value) return parameter.value;
      }
      return '-';
    };
    const portBinding = (number: number, kind: 'lan' | 'ssid') => {
      const path = kind === 'lan' ? lanEnablePaths[number] : ssidEnablePaths[number];
      return path ? enabled(relevant.find(p => p.name === path)?.value ?? '') : false;
    };
    const natValue = ownValue('NATEnabled');
    const lanEnablePaths: Record<number, string> = {};
    const ssidEnablePaths: Record<number, string> = {};
    for (const p of relevant) {
      if (!p.name.includes('.X_HW_LANBIND.')) continue;
      const lanMatch = p.name.match(/\.Lan(\d+)Enable$/i);
      if (lanMatch) { lanEnablePaths[Number(lanMatch[1])] = p.name; continue; }
      const ssidMatch = p.name.match(/\.SSID(\d+)Enable$/i);
      if (ssidMatch) { ssidEnablePaths[Number(ssidMatch[1])] = p.name; }
    }
    const hasBooleanPaths = Object.keys(lanEnablePaths).length > 0 || Object.keys(ssidEnablePaths).length > 0;
    const portParams = hasBooleanPaths
      ? {
          ...(Object.keys(lanEnablePaths).length > 0 ? { lanEnablePaths } : {}),
          ...(Object.keys(ssidEnablePaths).length > 0 ? { ssidEnablePaths } : {}),
        }
      : undefined;
    return {
      path,
      wanDevice: group.wanDevice,
      connectionDevice: group.connectionDevice,
      instance: group.instance,
      kind: group.kind as WanProfile['kind'],
      canDeleteObject,
      name: ownValue('Name') !== '-' ? ownValue('Name') : `WANDevice.${group.wanDevice} / WANConnectionDevice.${group.connectionDevice} / ${group.kind}.${group.instance}`,
      status: ownValue('ConnectionStatus'),
      enable: (() => { const v = ownValue('Enable'); return v === '-' ? '-' : enabled(v) ? 'Enabled' : 'Disabled'; })(),
      vlan: firstValue('X_HW_VLAN', 'VLANID', 'VLANIDMark', 'X_CT_VLAN', 'WANEponLinkConfig.VLANIDMark'),
      username: ownValue('Username'),
      password: ownValue('Password'),
      ipAddress: firstValue('ExternalIPAddress', 'IPAddress'),
      macAddress: ownValue('MACAddress'),
      service: firstValue('X_HW_SERVICELIST', 'X_HW_ServiceList', 'ServiceList', 'X_CT_ServiceList', 'X_CU_ServiceList'),
      nat: natValue === '-' ? '-' : enabled(natValue) ? 'Enabled' : 'Disabled',
      type: ownValue('ConnectionType') !== '-' ? ownValue('ConnectionType') : group.kind === 'WANPPPConnection' ? 'PPP' : 'IP',
      uptime: ownValue('Uptime'),
      lan1: portBinding(1, 'lan'),
      lan2: portBinding(2, 'lan'),
      lan3: portBinding(3, 'lan'),
      lan4: portBinding(4, 'lan'),
      ssid1: portBinding(1, 'ssid'),
      ssid2: portBinding(2, 'ssid'),
      ssid3: portBinding(3, 'ssid'),
      ssid4: portBinding(4, 'ssid'),
      ssid5: portBinding(5, 'ssid'),
      ssid6: portBinding(6, 'ssid'),
      ssid7: portBinding(7, 'ssid'),
      ssid8: portBinding(8, 'ssid'),
      portParams,
    };
  });
}

export function buildExclusiveTieParams(
  profiles: WanProfile[],
  target: WanProfile,
  portNumber: number,
  kind: 'lan' | 'ssid',
  enable: boolean,
): Record<string, string> {
  const params: Record<string, string> = {};
  const targetPath = kind === 'ssid'
    ? target.portParams?.ssidEnablePaths?.[portNumber]
    : target.portParams?.lanEnablePaths?.[portNumber];
  if (!targetPath) return params;
  params[targetPath] = enable ? '1' : '0';
  if (enable) {
    for (const p of profiles) {
      if (p.path === target.path) continue;
      const otherPath = kind === 'ssid'
        ? p.portParams?.ssidEnablePaths?.[portNumber]
        : p.portParams?.lanEnablePaths?.[portNumber];
      if (otherPath) params[otherPath] = '0';
    }
  }
  return params;
}
