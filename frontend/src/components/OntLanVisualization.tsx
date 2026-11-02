import type { Component } from 'solid-js';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { formatLanRate, formatLanSpeed, measureCounterRate, resolveLanVisualState, type LanCounterSample, type OntLanPort } from '../lib/ontLan';
import './OntLanVisualization.css';

interface Props {
  svgMarkup: string;
  ports: OntLanPort[];
  deviceOnline: boolean;
  showActivity?: boolean;
}

const linkLabel = (link: OntLanPort['link'], online: boolean) => !online || link === 'unknown' ? 'Unknown' : link === 'up' ? 'Link Up' : 'Link Down';

const OntLanVisualization: Component<Props> = (props) => {
  let svgHost: HTMLDivElement | undefined;
  const [activePorts, setActivePorts] = createSignal<Set<number>>(new Set());
  const [rates, setRates] = createSignal<Record<number, { rx: number | null; tx: number | null; sampledAt: string | null }>>({});
  const previousCounters = new Map<string, LanCounterSample>();
  const activityTimers = new Map<number, number>();

  const safeSvg = () => props.svgMarkup
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\sstyle="[^"]*"/gi, '');

  createEffect(() => {
    const markup = props.svgMarkup;
    const ports = props.ports;
    const online = props.deviceOnline;
    const svg = svgHost?.querySelector('svg');
    if (!svg) return;

    for (const port of ports) {
      const group = svg.getElementById(`lan${port.port}`) as SVGGElement | null;
      if (!group) continue;
      const visual = resolveLanVisualState(port.link, online, port.cableConnected, props.showActivity !== false && activePorts().has(port.port));
      group.classList.add('lan');
      group.classList.toggle('is-connected', visual.connected);
      group.classList.toggle('is-up', visual.linkUp);
      group.classList.toggle('is-traffic', visual.activity);
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'group');
      const label = `LAN${port.port}: ${linkLabel(port.link, online)}`;
      group.setAttribute('aria-label', label);
      let title = svg.getElementById(`lan${port.port}-title`);
      if (!title) {
        title = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.id = `lan${port.port}-title`;
        group.prepend(title);
      }
      const rx = online ? rateLabel(port.port, 'rx') : 'N/A';
      const tx = online ? rateLabel(port.port, 'tx') : 'N/A';
      title.textContent = [
        label,
        `Last reported: ${port.statusUpdatedAt ? new Date(port.statusUpdatedAt).toLocaleString() : 'N/A'}`,
        `Speed: ${online ? formatLanSpeed(port.speed) : 'N/A'}`,
        `Duplex: ${online ? port.duplex || 'N/A' : 'N/A'}`,
        `RX: ${rx}`,
        `TX: ${tx}`,
      ].join('\n');
    }
    void markup;
  });

  createEffect(() => {
    const ports = props.ports;
    if (!props.deviceOnline || props.showActivity === false) {
      for (const timer of activityTimers.values()) window.clearTimeout(timer);
      activityTimers.clear();
      setActivePorts(new Set<number>());
      return;
    }

    setRates(previous => {
      const next = { ...previous };
      for (const port of ports) {
        const rxKey = `lan${port.port}:rx`;
        const txKey = `lan${port.port}:tx`;
        const rxRate = measureCounterRate(previousCounters.get(rxKey), port.rx);
        const txRate = measureCounterRate(previousCounters.get(txKey), port.tx);
        const sampledAt = [port.rx.updatedAt, port.tx.updatedAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
        if (rxRate !== null || txRate !== null) {
          next[port.port] = { rx: rxRate, tx: txRate, sampledAt };
          if ((rxRate ?? 0) > 0 || (txRate ?? 0) > 0) {
            setActivePorts(current => new Set(current).add(port.port));
            const existing = activityTimers.get(port.port);
            if (existing) window.clearTimeout(existing);
            activityTimers.set(port.port, window.setTimeout(() => {
              setActivePorts(current => { const updated = new Set(current); updated.delete(port.port); return updated; });
              activityTimers.delete(port.port);
            }, 1600));
          }
        }
        previousCounters.set(rxKey, port.rx);
        previousCounters.set(txKey, port.tx);
      }
      return next;
    });
  });

  onCleanup(() => { for (const timer of activityTimers.values()) window.clearTimeout(timer); });

  const rateLabel = (port: number, direction: 'rx' | 'tx') => {
    const rate = rates()[port];
    return rate ? formatLanRate(rate[direction], rate.sampledAt) : 'N/A';
  };

  return <section class="ont-lan-visualization" aria-label="CPE LAN port status">
    <Show when={props.svgMarkup.trim()} fallback={<p class="text-sm text-muted" role="status">The template LAN visualization could not be loaded. LAN interface data remains available in the table below.</p>}>
      <div ref={svgHost} class="ont-svg-host" innerHTML={safeSvg()} />
      <div class="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-secondary" aria-label="LAN port states">
        <For each={props.ports}>{port => <span class="font-mono">LAN{port.port}: {linkLabel(port.link, props.deviceOnline)}</span>}</For>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-secondary" aria-label="Port status legend">
        <span><i class="ont-status-dot ont-status-dot--up" aria-hidden="true" />Link up</span>
        <span><i class="ont-status-dot ont-status-dot--down" aria-hidden="true" />Cable known, link down</span>
        <span><i class="ont-status-dot ont-status-dot--unknown" aria-hidden="true" />Unknown</span>
      </div>
      <Show when={!props.deviceOnline}><p class="mt-2 text-center text-xs text-warning" role="status">Device offline; current port states and traffic activity are unknown.</p></Show>
    </Show>
  </section>;
};

export default OntLanVisualization;
