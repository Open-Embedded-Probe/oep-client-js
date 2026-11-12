// The page's own state (inputs kept while moving between screens) and the busy / feedback rules every action uses.
import { el } from './ui.js';

export const state = {
  /** the purpose chosen before installing or connecting (§4.2): kept through board choice, permissions and retries */
  intent: '',
  /** where C01 returns after connecting */
  connectReturn: '/work',
  /** the installation in progress (I01) */
  install: null,
  /** the wiring editor's draft (W03) */
  draft: null, dirty: false, returnTo: '/connections',
  /** inputs of the operation screens, by operation id (kept, never re-run) */
  operations: {},
  /** debug scan inputs and the result chosen for the editor */
  debugScan: null, scanSelection: null,
  capture: null, passthrough: null, settingsDraft: {}, maintenance: {},
  notice: '', busy: false, transferred: false,
};

let renderer = (/** @type {boolean} */ _focus) => {};
export function setRenderer(fn) { renderer = fn; }
export function render(focus = false) { renderer(focus); }
export const routeNow = () => location.hash.startsWith('#/') ? location.hash.slice(1) : '/home';

export function announce(text) { const a = document.getElementById('announcer'); if (a) a.textContent = text; }
export function feedback(text, kind = '') {
  const f = document.getElementById('feedback');
  if (!f) return;
  f.hidden = !text; f.className = `feedback ${kind}`; f.textContent = text;
}

export function discardThen(next) {
  if (!state.dirty) { next(); return; }
  const dialog = el('dialog', { class: 'exit-dialog', 'aria-labelledby': 'discard-title' },
    el('h2', { id: 'discard-title' }, '保存していない変更があります'), el('p', {}, '編集を続けるか、変更を破棄して移動してください。'),
    el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn primary', onclick: () => { dialog.close(); dialog.remove(); } }, '編集を続ける'),
      el('button', { type: 'button', class: 'btn', onclick: () => { state.dirty = false; state.draft = null; dialog.close(); dialog.remove(); next(); } }, '破棄して移動')));
  dialog.addEventListener('cancel', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
export function go(route) {
  if (route === routeNow()) { render(); return; }
  discardThen(() => { location.hash = route; });
}

/** Run a device action: one at a time, the page's buttons off meanwhile, the outcome said near the screen. */
export async function run(title, fn) {
  if (state.busy) return;
  state.busy = true; document.body.dataset.busy = 'true';
  document.querySelectorAll('main button, main input, main select, main textarea').forEach((b) => { /** @type {any} */ (b).disabled = true; });
  feedback(`${title}…`, 'busy');
  try {
    const out = await fn();
    feedback(out === false ? '' : `${title}：完了`, 'good');
  } catch (error) {
    const cancelled = error?.name === 'NotFoundError' || error?.name === 'AbortError';
    feedback(cancelled ? '機器の選択をキャンセルしました。' : `${title}：${errorText(error)}`, cancelled ? '' : 'bad');
    if (!cancelled) console.warn(error);
  } finally {
    state.busy = false; document.body.dataset.busy = 'false'; render();
  }
}
let errorTextFn = (e) => (e instanceof Error ? e.message : String(e));
export function setErrorText(fn) { errorTextFn = fn; }
export function errorText(e) { return errorTextFn(e); }

/** A button that runs `fn` through run(). */
export function action(text, fn, style = '', attrs = {}) {
  return el('button', { type: 'button', class: `btn ${style}`, disabled: state.busy || attrs.disabled, ...attrs, onclick: () => run(text, fn) }, text);
}
/** A button for screen-only changes (no device). */
export function button(text, onClick, style = '', attrs = {}) {
  return el('button', { type: 'button', class: `btn ${style}`, onclick: onClick, ...attrs, disabled: state.busy || attrs.disabled }, text);
}
