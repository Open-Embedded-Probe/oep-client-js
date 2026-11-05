// Rules shared by new and edited connections. No device operations occur here.
import { connectionName } from './model.js';

/** Build a collision-free label change, checking the editor's original snapshot.
 * @param {{ name:string, labels:[number,string][], original?:{name:string,lines:[number,string][]}|null,
 * desired:[number,string][] }} input
 */
export function connectionChange({ name, labels, original = null, desired }) {
  connectionName(name, [...new Set(labels.flatMap(([, l]) => /^([A-Za-z][A-Za-z0-9-]{0,15})[.@]/.exec(l)?.[1] ?? []))].filter((n) => n.toLowerCase() !== original?.name.toLowerCase()));
  if (!desired.length) throw new Error('Choose at least one pin.');
  const current = new Map(labels), before = new Map(original?.lines ?? []);
  for (const [ch, label] of before) if (current.get(ch) !== label) throw new Error('The connection changed while editing. Reload it before saving.');
  if (original && labels.some(([ch,l]) => /^([A-Za-z][A-Za-z0-9-]{0,15})[.@]/.exec(l)?.[1]?.toLowerCase() === original.name.toLowerCase() && !before.has(ch))) throw new Error('The connection changed while editing. Reload it before saving.');
  if (new Set(desired.map(([ch]) => ch)).size !== desired.length || new Set(desired.map(([, line]) => line.toLowerCase())).size !== desired.length) throw new Error('Signal names and pins must be unique.');
  const next = new Map(desired.map(([ch, line]) => {
    if (!Number.isInteger(ch) || ch < 0 || ch > 65534) throw new Error('Invalid pin number.');
    if (!/^(?:[a-zA-Z0-9_-]+(?:@[a-zA-Z0-9_-]+)?|@[a-zA-Z0-9_-]+)$/.test(line)) throw new Error('Invalid signal name.');
    if (current.has(ch) && !before.has(ch)) throw new Error(`Pin ${ch} is already used by ${current.get(ch)}.`);
    const label = `${name}${line.startsWith('@') ? '' : '.'}${line}`;
    if (new TextEncoder().encode(label).length > 32) throw new Error('A complete pin label must fit in 32 bytes. Shorten the connection or signal name.');
    return [ch, label];
  }));
  // Free old labels before moving a signal to another pin (labels must be unique).
  const unset = [...before].filter(([ch, label]) => next.get(ch) !== label).map(([ch]) => ch);
  const set = [...next].filter(([ch, label]) => current.get(ch) !== label);
  return { unset, set };
}
