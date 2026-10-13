import type { MetricDefinition } from './api';

/**
 * Metrics shown in the Metrics tab (line/bar charts).
 *
 * Every matching metric appears here, regardless of whether it is also
 * enabled for the Device Health panel. The two views are independent: a
 * metric can be a line chart in the Metrics tab while simultaneously
 * appearing as a number or gauge tile in the Health panel.
 */
export function metricsTabMetrics(defs: MetricDefinition[]): MetricDefinition[] {
  return defs.filter(d => d.store_history !== false);
}

/**
 * Metrics shown in the Device Health panel (number/gauge tiles).
 * Only metrics with `health` enabled appear here.
 */
export function healthPanelMetrics(defs: MetricDefinition[]): MetricDefinition[] {
  return defs
    .filter(d => d.health)
    .map((def, index) => ({ def, index }))
    .sort((a, b) => (a.def.health_order ?? 0) - (b.def.health_order ?? 0) || a.index - b.index)
    .map(({ def }) => def);
}

/**
 * globMatch reports whether `value` matches the shell-style `pattern`,
 * replicating Go's `path.Match` semantics (the backend uses `path.Match` to
 * decide which metrics apply to a device).
 *
 *   - `*` matches any sequence of non-`/` characters (zero or more)
 *   - `?` matches any single non-`/` character
 *   - `[...]` matches a single character in a set (`^` negates, `-` ranges)
 *   - `\` escapes the next character
 *
 * The pattern must match the ENTIRE value. An empty pattern or a bare `*`
 * matches everything (mirroring the backend's `deviceTypeMatches`, which
 * special-cases `""` and `"*"` before calling `path.Match`).
 *
 * Matching is case-insensitive (both sides are lowercased), mirroring the
 * backend's case-insensitive template→device resolution.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '' || pattern === '*') return true;

  // Case-insensitive: metric matching must stay consistent with the backend's
  // case-insensitive template→device resolution (LOWER() in SQL).
  let name = value.toLowerCase();
  let pat = pattern.toLowerCase();
  Pattern: while (pat.length > 0) {
    const { star, chunk, rest } = scanChunk(pat);
    pat = rest;
    if (star && chunk === '') {
      // Trailing `*` matches the rest of the string unless it contains a `/`.
      return name.indexOf('/') < 0;
    }
    const m = matchChunk(chunk, name);
    if (m.err) return false;
    if (m.ok && (m.rest.length === 0 || pat.length > 0)) {
      name = m.rest;
      continue;
    }
    if (star) {
      // Retry the chunk at each position, never skipping over a `/`.
      for (let i = 0; i < name.length && name[i] !== '/'; i++) {
        const m2 = matchChunk(chunk, name.slice(i + 1));
        if (m2.err) return false;
        if (m2.ok) {
          if (pat.length === 0 && m2.rest.length > 0) continue;
          name = m2.rest;
          continue Pattern;
        }
      }
    }
    // No match. Verify the remaining pattern is at least syntactically valid
    // (a malformed pattern reports as a non-match, matching Go's error path).
    for (let p = pat; p.length > 0; ) {
      const sc = scanChunk(p);
      p = sc.rest;
      if (matchChunk(sc.chunk, '').err) return false;
    }
    return false;
  }
  return name.length === 0;
}

/**
 * metricsForTemplate returns the metrics that apply to a provisioning
 * template's device scope, mirroring how the backend resolves which metrics
 * are collected for the devices covered by that template.
 *
 *   - global (both empty)         → every metric
 *   - concrete (both set)         → metrics whose pattern matches `m/p`
 *   - manufacturer only (m set)   → metrics whose pattern matches some `m/*`
 *   - product class only (p set)  → metrics whose pattern matches a device of that product class
 */
export function metricsForTemplate(
  defs: MetricDefinition[],
  manufacturer: string,
  productClass: string,
): MetricDefinition[] {
  const m = (manufacturer || '').trim();
  const p = (productClass || '').trim();

  // Global scope: every metric applies.
  if (m === '' && p === '') return defs;

  // Concrete scope: the device type is exactly `m/p`.
  if (m !== '' && p !== '') {
    const deviceType = `${m}/${p}`;
    return defs.filter((d) => globMatch(d.device_type_match, deviceType));
  }

  // Partial scope: exactly one dimension is fixed. A metric applies when its
  // pattern's corresponding segment matches the fixed value (the other
  // segment is a wildcard that matches some device within the scope).
  return defs.filter((d) => {
    const pattern = d.device_type_match;
    if (pattern === '' || pattern === '*') return true;
    const segments = pattern.split('/');
    if (segments.length !== 2) return false;
    return m !== '' ? globMatch(segments[0], m) : globMatch(segments[1], p);
  });
}

// --- Go path.Match helpers (faithful port) --------------------------------

// scanChunk splits off the next non-`*` chunk, reporting whether it was
// preceded by a `*`.
function scanChunk(pattern: string): { star: boolean; chunk: string; rest: string } {
  let star = false;
  while (pattern.length > 0 && pattern[0] === '*') {
    pattern = pattern.slice(1);
    star = true;
  }
  let inRange = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (i + 1 < pattern.length) i++;
    } else if (c === '[') {
      inRange = true;
    } else if (c === ']') {
      inRange = false;
    } else if (c === '*' && !inRange) {
      return { star, chunk: pattern.slice(0, i), rest: pattern.slice(i) };
    }
  }
  return { star, chunk: pattern, rest: '' };
}

// matchChunk checks whether `chunk` matches the beginning of `s`, returning
// the remainder of `s` after the match.
function matchChunk(chunk: string, s: string): { rest: string; ok: boolean; err: boolean } {
  let failed = false;
  while (chunk.length > 0) {
    failed = failed || s.length === 0;
    const c = chunk[0];
    if (c === '[') {
      let r = '';
      if (!failed) {
        r = s[0];
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
      let negated = false;
      if (chunk.length > 0 && chunk[0] === '^') {
        negated = true;
        chunk = chunk.slice(1);
      }
      let match = false;
      let nrange = 0;
      for (;;) {
        if (chunk.length > 0 && chunk[0] === ']' && nrange > 0) {
          chunk = chunk.slice(1);
          break;
        }
        const loRes = getEsc(chunk);
        if (loRes.err) return { rest: '', ok: false, err: true };
        const lo = loRes.r;
        chunk = loRes.nchunk;
        let hi = lo;
        if (chunk.length > 0 && chunk[0] === '-') {
          const hiRes = getEsc(chunk.slice(1));
          if (hiRes.err) return { rest: '', ok: false, err: true };
          hi = hiRes.r;
          chunk = hiRes.nchunk;
        }
        match = match || (lo <= r && r <= hi);
        nrange++;
      }
      failed = failed || (match === negated);
    } else if (c === '?') {
      if (!failed) {
        failed = s[0] === '/';
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
    } else if (c === '\\') {
      chunk = chunk.slice(1);
      if (chunk.length === 0) return { rest: '', ok: false, err: true };
      if (!failed) {
        failed = chunk[0] !== s[0];
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
    } else {
      if (!failed) {
        failed = c !== s[0];
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
    }
  }
  if (failed) return { rest: '', ok: false, err: false };
  return { rest: s, ok: true, err: false };
}

// getEsc reads a single (possibly escaped) character from a character class.
function getEsc(chunk: string): { r: string; nchunk: string; err: boolean } {
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') {
    return { r: '', nchunk: '', err: true };
  }
  if (chunk[0] === '\\') {
    chunk = chunk.slice(1);
    if (chunk.length === 0) return { r: '', nchunk: '', err: true };
  }
  const r = chunk[0];
  const nchunk = chunk.slice(1);
  if (nchunk.length === 0) return { r, nchunk: '', err: true };
  return { r, nchunk, err: false };
}
