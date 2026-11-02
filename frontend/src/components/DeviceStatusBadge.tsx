import type { Component } from 'solid-js';
import type { Device } from '../lib/api';
import { deviceStatus } from '../lib/deviceStatus';

const DeviceStatusBadge: Component<{ device: Pick<Device, 'online' | 'last_inform'> }> = (props) => {
  const status = () => deviceStatus(props.device);
  return <span class={`badge ${status() === 'Online' ? 'badge-success' : status() === 'Waiting' ? 'badge-warning' : 'badge-error'}`} title={status() === 'Waiting' ? 'Awaiting the first CWMP Inform' : undefined}>{status()}</span>;
};

export default DeviceStatusBadge;
