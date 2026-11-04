import { createSignal } from 'solid-js';

export const DATE_TIME_FORMATS = [
  { value: 'locale', label: '6 Nov 2026, 14:05 (default)' },
  { value: 'dmy', label: 'DD.MM.YYYY HH:mm:ss' },
  { value: 'ymd', label: 'YYYY-MM-DD HH:mm:ss' },
  { value: 'mdy', label: 'MM/DD/YYYY hh:mm:ss AM/PM' },
  { value: 'iso', label: 'ISO 8601 (UTC)' },
] as const;
export type DateTimeFormat = typeof DATE_TIME_FORMATS[number]['value'];
const [dateTimeFormat, setFormat] = createSignal<DateTimeFormat>('locale');
export { dateTimeFormat };
export const setDateTimeFormat = (value?: string) => setFormat(DATE_TIME_FORMATS.some(option => option.value === value) ? value as DateTimeFormat : 'locale');
const locale = 'en-GB';

const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const relativeFormatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

export const formatDateTime = (value?: string | Date | number | null, format: DateTimeFormat = dateTimeFormat()): string => {
  if (value == null || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  if (format === 'locale') return dateTimeFormatter.format(date);
  if (format === 'iso') return date.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = pad(date.getDate()), month = pad(date.getMonth() + 1), year = String(date.getFullYear()).padStart(4, '0');
  const hour = date.getHours(), minute = pad(date.getMinutes()), second = pad(date.getSeconds());
  if (format === 'mdy') return `${month}/${day}/${year} ${pad(hour % 12 || 12)}:${minute}:${second} ${hour < 12 ? 'AM' : 'PM'}`;
  return `${format === 'dmy' ? `${day}.${month}.${year}` : `${year}-${month}-${day}`} ${pad(hour)}:${minute}:${second}`;
};

export const formatParameterDateTime = (value: string, valueType?: string): string => /^(?:(?:xsd|xs):)?dateTime$/i.test(valueType || '') ? formatDateTime(value) : value;

export const formatRelativeTime = (value?: string | Date | null): string => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const deltaSeconds = (date.getTime() - Date.now()) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  if (absoluteSeconds < 60) return relativeFormatter.format(Math.round(deltaSeconds), 'second');
  if (absoluteSeconds < 3600) return relativeFormatter.format(Math.round(deltaSeconds / 60), 'minute');
  if (absoluteSeconds < 86400) return relativeFormatter.format(Math.round(deltaSeconds / 3600), 'hour');
  return relativeFormatter.format(Math.round(deltaSeconds / 86400), 'day');
};
