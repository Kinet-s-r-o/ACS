export type LanLinkState = 'up' | 'down' | 'unknown';

export interface LanCounterSample {
  value: number | null;
  updatedAt: string | null;
}

export interface OntLanPort {
  port: number;
  link: LanLinkState;
  cableConnected?: boolean | null;
  statusUpdatedAt: string | null;
  speed: string | null;
  duplex: string | null;
  rx: LanCounterSample;
  tx: LanCounterSample;
}

export function resolveLanVisualState(link: LanLinkState, online: boolean, cableConnected: boolean | null | undefined, activity: boolean) {
  const linkUp = online && link === 'up';
  return {
    connected: linkUp || cableConnected === true,
    linkUp,
    activity: linkUp && activity,
  };
}

export function parseLanLinkState(value: string | null | undefined): LanLinkState {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'up' || normalized === 'linkup' || normalized === 'connected') return 'up';
  if (normalized === 'down' || normalized === 'linkdown' || normalized === 'nolink' || normalized === 'disconnected' || normalized === 'lowerlayerdown' || normalized === 'dormant' || normalized === 'notpresent' || normalized === 'error') return 'down';
  return 'unknown';
}

export function measureCounterRate(
  previous: LanCounterSample | undefined,
  current: LanCounterSample,
): number | null {
  if (previous?.value === null || previous?.value === undefined || current.value === null || !previous.updatedAt || !current.updatedAt) return null;
  const elapsedSeconds = (Date.parse(current.updatedAt) - Date.parse(previous.updatedAt)) / 1000;
  const deltaBytes = current.value - previous.value;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || !Number.isFinite(deltaBytes) || deltaBytes <= 0) return null;
  return deltaBytes * 8 / elapsedSeconds;
}

export function formatLanRate(bitsPerSecond: number | null | undefined, sampledAt?: string | null, now = Date.now()): string {
  if (bitsPerSecond === null || bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond) || bitsPerSecond < 0) return 'N/A';
  const age = sampledAt ? now - Date.parse(sampledAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(age) || age < 0 || age > 120_000) return 'N/A';
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
}

export function formatLanSpeed(value: string | null | undefined): string {
  const speed = value?.trim();
  if (!speed || speed === '-' || speed === '0') return 'N/A';
  if (/\d+(?:\.\d+)?\s*(?:mbps|gbps)$/i.test(speed)) return speed.replace(/\s+/g, ' ');
  const numeric = Number(speed);
  if (Number.isFinite(numeric) && numeric > 0) {
    const mbps = numeric >= 1_000_000 ? numeric / 1_000_000 : numeric;
    return `${mbps >= 1000 ? (mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1) + ' Gbps' : `${mbps} Mbps`}`;
  }
  return speed;
}
