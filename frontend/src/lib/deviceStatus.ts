import type { Device } from './api';

export const deviceStatus = (device: Pick<Device, 'online' | 'last_inform'>) =>
  device.online ? 'Online' : device.last_inform ? 'Offline' : 'Waiting';
