import type { Component } from 'solid-js';
import { createEffect, For, Show } from 'solid-js';
import { formatLanSpeed, resolveLanVisualState, type OntLanPort } from '../lib/ontLan';
import './OntLanVisualization.css';

interface Props {
  svgMarkup: string;
  ports: OntLanPort[];
  deviceOnline: boolean;
}

const linkLabel = (link: OntLanPort['link'], online: boolean) => !online || link === 'unknown' ? 'Unknown' : link === 'up' ? 'Link Up' : 'Link Down';

const OntLanVisualization: Component<Props> = (props) => {
  let svgHost: HTMLDivElement | undefined;

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
      const visual = resolveLanVisualState(port.link, online, port.cableConnected);
      group.classList.add('lan');
      group.classList.toggle('is-connected', visual.connected);
      group.classList.toggle('is-up', visual.linkUp);
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
      title.textContent = [
        label,
        `Last reported: ${port.statusUpdatedAt ? new Date(port.statusUpdatedAt).toLocaleString() : 'N/A'}`,
        `Speed: ${online ? formatLanSpeed(port.speed) : 'N/A'}`,
        `Duplex: ${online ? port.duplex || 'N/A' : 'N/A'}`,
      ].join('\n');
    }
    void markup;
  });

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
      <Show when={!props.deviceOnline}><p class="mt-2 text-center text-xs text-warning" role="status">Device offline; current port states are unknown.</p></Show>
    </Show>
  </section>;
};

export default OntLanVisualization;
