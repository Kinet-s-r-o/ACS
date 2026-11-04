import { createSignal } from 'solid-js';
import { api } from './api';
import { setDateTimeFormat } from './dateTime';

export const APP_NAME = import.meta.env.VITE_APP_NAME || 'ACS';

const [appName, setAppName] = createSignal<string>(APP_NAME);
const [appLogo, setAppLogo] = createSignal<string>('');

export { appName, appLogo };

export function initAppName() {
  api.getMeta().then((meta) => {
    setDateTimeFormat(meta.ui_datetime_format);
    if (meta.app_name) {
      setAppName(meta.app_name);
      document.title = meta.app_name;
    }
    setAppLogo(meta.app_logo || '');
  }).catch(() => { /* keep fallback */ });
}
