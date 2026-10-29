import { createSignal } from 'solid-js';

export type UITransitionStyle = 'fade' | 'slide' | 'fade-slide';
export interface UITransitionSettings { enabled: boolean; style: UITransitionStyle; duration: number }

const STORAGE_KEY = 'acs.ui-transitions';
const defaults: UITransitionSettings = { enabled: false, style: 'fade-slide', duration: 250 };

const readStoredSettings = (): UITransitionSettings => {
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<UITransitionSettings>;
    return {
      enabled: stored.enabled === true,
      style: stored.style === 'fade' || stored.style === 'slide' || stored.style === 'fade-slide' ? stored.style : defaults.style,
      duration: [150, 250, 400, 600].includes(Number(stored.duration)) ? Number(stored.duration) : defaults.duration,
    };
  } catch { return defaults; }
};

const [settings, setSettings] = createSignal<UITransitionSettings>(readStoredSettings());

const applyDocumentSettings = (value: UITransitionSettings) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.uiMotion = value.enabled ? 'on' : 'off';
  root.dataset.uiMotionStyle = value.style;
  root.style.setProperty('--ui-transition-duration', `${value.duration}ms`);
};

applyDocumentSettings(settings());

export const getUITransitionSettings = settings;
let transitionTimeout = 0;

export const updateUITransitionSettings = (value: UITransitionSettings) => {
  setSettings(value);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Browser storage may be disabled; the in-memory setting still applies. */ }
  applyDocumentSettings(value);
};

export const transitionSettingsFromAPI = (values: Record<string, string>): UITransitionSettings => {
  const style = values.ui_transition_style;
  const duration = Number(values.ui_transition_duration);
  return {
    enabled: values.ui_transitions_enabled === 'true',
    style: style === 'fade' || style === 'slide' || style === 'fade-slide' ? style : defaults.style,
    duration: [150, 250, 400, 600].includes(duration) ? duration : defaults.duration,
  };
};

export const playUITransition = () => {
  if (!settings().enabled || typeof document === 'undefined') return;
  const content = document.querySelector<HTMLElement>('.content-area');
  if (!content) return;
  content.classList.remove('ui-transition-replay');
  void content.offsetWidth;
  content.classList.add('ui-transition-replay');
  window.clearTimeout(transitionTimeout);
  transitionTimeout = window.setTimeout(() => content.classList.remove('ui-transition-replay'), settings().duration + 80);
};
