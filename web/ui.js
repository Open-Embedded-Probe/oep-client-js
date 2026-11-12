// DOM helpers shared by every screen. Text from a probe or a file is always inserted as text, never as HTML.
let fieldCount = 0;
export function resetFieldIds() { fieldCount = 0; }
/** @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag @param {Record<string, any>} [attrs] @param {...any} kids
 * @returns {HTMLElementTagNameMap[T]} */
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key in node && !key.startsWith('aria') && !key.startsWith('data')) /** @type {any} */ (node)[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== false && kid !== undefined) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}
export const p = (text, cls = '') => el('p', { class: cls }, text);
export const badge = (text, cls = '') => el('span', { class: `badge ${cls}` }, text);
export const actions = (...items) => el('div', { class: 'actions' }, ...items);
export const link = (text, route, primary = false, attrs = {}) => el('a', { href: `#${route}`, class: `btn${primary ? ' primary' : ''}`, ...attrs }, text);
export const textLink = (text, route) => el('a', { href: `#${route}`, class: 'text-link' }, text);
export const external = (title, href) => el('a', { href, target: '_blank', rel: 'noopener', class: 'text-link' }, `${title} ↗`);
export const note = (text, cls = '') => el('div', { class: `note ${cls}` }, text);
export const panel = (...children) => el('section', { class: 'panel' }, ...children);
export const heading = (title, description, eyebrow = 'OEP WORKSPACE') => el('header', { class: 'page-heading' }, p(eyebrow, 'eyebrow'), el('h1', { tabindex: -1 }, title), description ? p(description) : null);
export function keyValues(rows) { return el('dl', { class: 'key-value' }, ...rows.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])); }
export function sectionTitle(title, description, eyebrow) {
  return el('div', { class: 'section-head' }, el('div', {}, eyebrow ? p(eyebrow, 'eyebrow') : null, el('h2', {}, title)), description ? p(description) : null);
}
/** A labelled input. choices: [[value, text], ...] makes a select. */
export function field(label, value, onInput, help = '', choices = null, type = 'text', attrs = {}) {
  const id = attrs.id ?? `field-${++fieldCount}`;
  const input = choices
    ? el('select', { id, onchange: (e) => onInput(e.target.value), ...attrs }, ...choices.map((c) => el('option', { value: String(c[0]) }, c[1])))
    : el(type === 'textarea' ? 'textarea' : 'input', { id, type: type === 'textarea' ? undefined : type, autocomplete: type === 'password' ? 'new-password' : 'off', spellcheck: false, oninput: (e) => onInput(e.target.value), ...attrs });
  /** @type {any} */ (input).value = value ?? '';
  return el('label', { class: 'field', htmlFor: id }, label, input, help ? el('small', {}, help) : null);
}
export function checkbox(label, checked, onChange, attrs = {}) {
  return el('label', { class: 'check-field' }, el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked), ...attrs }), label);
}
export function table(headings, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, headings.map((x) => el('th', { scope: 'col' }, x)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((x) => el('td', {}, x)))))));
}
export function terminal(text, label = '結果') { return el('pre', { class: 'terminal', role: 'log', 'aria-label': label }, text); }
export function copyLine(text) {
  return el('div', { class: 'copy-line' }, el('code', {}, text), el('button', { type: 'button', class: 'btn small', onclick: async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'コピーしました'; } catch { e.target.textContent = 'コピーできません'; }
  } }, 'コピー'));
}
export function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
