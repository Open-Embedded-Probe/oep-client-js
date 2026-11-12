// The page language (page.ja.md §9: English and Japanese). The browser's languages pick the default; the header's
// selector overrides it and is remembered in this browser. Texts are written in place as t(en, ja), or as { en, ja }
// objects read with tr(). Changing the language only re-renders: inputs, the probe and the route stay.
export const LANGUAGES = [['en', 'English'], ['ja', '日本語']];
const KEY = 'oep-web-language';
const known = (l) => LANGUAGES.some(([id]) => id === l);
function stored() { try { return localStorage.getItem(KEY); } catch { return null; } }
function detect() {
  const saved = stored();
  if (known(saved)) return saved;
  const wanted = (globalThis.navigator?.languages?.length ? navigator.languages : [globalThis.navigator?.language ?? '']);
  for (const w of wanted) { const base = String(w).toLowerCase().split('-')[0]; if (known(base)) return base; }
  return 'en';
}
export let lang = detect();
const listeners = [];
/** Called after the language changes, in the order registered (data first, then the render). */
export function onLanguage(fn) { listeners.push(fn); }
export function setLang(next) {
  if (!known(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* the choice lasts for this page only */ }
  applyDocument();
  for (const fn of listeners) fn(lang);
}
/** The text in the page language. */
export const t = (en, ja) => (lang === 'ja' ? ja : en);
/** A { en, ja } text in the page language; anything else is returned as it is. */
export const tr = (text) => (text && typeof text === 'object' && 'en' in text ? (text[lang] ?? text.en) : text);
export function applyDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', t('Turn a board at hand into an OEP probe, then install, set up and use it from the browser.', '手元のボードをOEPプローブにして、ブラウザから導入・設定・操作します。'));
  const skip = document.querySelector('a.skip');
  if (skip) skip.textContent = t('Skip to content', '本文へ移動');
}
