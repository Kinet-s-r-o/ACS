export type LanLinkState = 'up' | 'down' | 'unknown';

export interface OntLanPort {
  port: number;
  link: LanLinkState;
  cableConnected?: boolean | null;
  statusUpdatedAt: string | null;
  speed: string | null;
  duplex: string | null;
}

export function resolveLanVisualState(link: LanLinkState, online: boolean, cableConnected: boolean | null | undefined) {
  const linkUp = online && link === 'up';
  return {
    connected: linkUp || cableConnected === true,
    linkUp,
  };
}

export function parseLanLinkState(value: string | null | undefined): LanLinkState {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'up' || normalized === 'linkup' || normalized === 'connected') return 'up';
  if (normalized === 'down' || normalized === 'linkdown' || normalized === 'nolink' || normalized === 'disconnected' || normalized === 'lowerlayerdown' || normalized === 'dormant' || normalized === 'notpresent' || normalized === 'error') return 'down';
  return 'unknown';
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
