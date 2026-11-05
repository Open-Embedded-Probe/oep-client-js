// Shared, DOM-free rules for the browser workspace.
/** @param {string} raw @param {number} [min] @param {number} [max] */
export function integer(raw, min = 0, max = 0xffffffff) {
  const text = String(raw).trim();
  if (!/^(?:0x[\da-f]+|\d+)$/i.test(text)) throw new RangeError(`Invalid integer: ${text}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${text}: ${min} … ${max}`);
  return n;
}
/** @param {string} raw */
export function hexBytes(raw) {
  const s = raw.trim().replace(/0x/gi, '').replace(/[\s,:_-]/g, '');
  if (!/^(?:[\da-f]{2})*$/i.test(s)) throw new RangeError('Hex bytes must contain pairs of hexadecimal digits.');
  return Uint8Array.from(s.match(/../g) ?? [], (v) => parseInt(v, 16));
}
/** @param {unknown} value */
export function printable(value) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array
    ? { hex: Array.from(v, (x) => x.toString(16).padStart(2, '0')).join(' '), text: new TextDecoder().decode(v) }
    : v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v, 2) ?? 'OK';
}
const aliases = { target: 'target/new', try: 'signals/gpio', details: 'diagnostics', start: 'firmware', boards: 'help', about: 'help', features: 'help' };
const views = new Set(['home', 'connect', 'probe', 'targets', 'target', 'signals', 'debug', 'tools', 'settings', 'storage', 'firmware', 'diagnostics', 'help']);
/** @param {string} hash */
export function parseRoute(hash) {
  const raw = hash.replace(/^#\/?/, '') || 'home';
  if (raw.startsWith('boards/')) return { view: 'help', arg: raw.slice(7) };
  const mapped = /** @type {Record<string, string>} */ (aliases)[raw] ?? raw;
  const [view, arg = ''] = mapped.split('/');
  return views.has(view) ? { view, arg } : { view: 'home', arg: '' };
}
/** @param {string} name @param {string[]} existing */
export function connectionName(name, existing = []) {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(name)) throw new RangeError('A connection name starts with a letter and has up to 16 letters, digits or hyphens.');
  if (existing.some((s) => s.toLowerCase() === name.toLowerCase())) throw new RangeError(`Connection already exists: ${name}`);
  return name;
}
/** @param {string | null | undefined} current @param {string | null | undefined} latest */
export function firmwareState(current, latest) {
  const parse = (/** @type {string | null | undefined} */ s) => /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec((s ?? '').split('+')[0]);
  const a = parse(current), b = parse(latest);
  if (!a || !b) return 'unknown';
  for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +a[i] < +b[i] ? 'update' : 'newer';
  return 'current';
}
