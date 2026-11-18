// Shared, DOM-free rules for the browser workspace.
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

