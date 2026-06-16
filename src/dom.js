// Low-level DOM plumbing shared by the view modules: root element refs, the
// modal/sheet scrim, toasts, in-app dialogs, the theme toggle, and the small
// bag of mutable UI runtime state (V). Depends only on constants + state, so it
// sits below the view layer in the dependency graph.

import { esc, THEMEKEY } from './constants.js';
import { nowMonth } from './state.js';

// ── Shared UI runtime state ────────────────────────────────────────────────────
// Kept on one object so the view modules can read/write it without a tangle of
// per-field setters across module boundaries.
export const V = {
  view: 'boot',          // 'boot' | 'login' | 'onboarding' | 'shell'
  activeTab: 'overview', // current bottom-nav tab
  spendMonth: nowMonth(),// month shown on the Spending tab
  lastCat: 'food',       // category to pre-select in the add-spend sheet
  booted: false,         // has the first render happened?
};

// ── Root elements ───────────────────────────────────────────────────────────────
export const appEl = document.getElementById('app');
export const scrim = document.getElementById('scrim');
export function closeSheet() { scrim.classList.remove('open'); scrim.innerHTML = ''; }
scrim.onclick = (e) => { if (e.target === scrim) closeSheet(); };

// ── Theme (light / dark) ──────────────────────────────────────────────────────
export function getTheme() { try { return localStorage.getItem(THEMEKEY) || 'light'; } catch (e) { return 'light'; } }
export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEMEKEY, t); } catch (e) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#15171C' : '#191B21');
}
applyTheme(getTheme());

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── In-app dialogs (replace native confirm/alert) ─────────────────────────────
// confirmDialog returns a Promise<boolean>; alertDialog a Promise<void>.
export function confirmDialog(message, { okText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let el = document.getElementById('modal');
    if (!el) { el = document.createElement('div'); el.id = 'modal'; document.body.appendChild(el); }
    el.className = 'modal-scrim open';
    el.innerHTML = `<div class="modal-box">
      <div class="modal-msg">${esc(message)}</div>
      <div class="btnrow">
        <button class="ghost" id="m_cancel">${esc(cancelText)}</button>
        <button class="primary" id="m_ok"${danger ? ' style="background:var(--danger)"' : ''}>${esc(okText)}</button>
      </div>
    </div>`;
    const done = (v) => { el.className = 'modal-scrim'; el.innerHTML = ''; resolve(v); };
    el.querySelector('#m_cancel').onclick = () => done(false);
    el.querySelector('#m_ok').onclick = () => done(true);
    el.onclick = (e) => { if (e.target === el) done(false); };
  });
}
export function alertDialog(message, okText = 'OK') {
  return new Promise((resolve) => {
    let el = document.getElementById('modal');
    if (!el) { el = document.createElement('div'); el.id = 'modal'; document.body.appendChild(el); }
    el.className = 'modal-scrim open';
    el.innerHTML = `<div class="modal-box">
      <div class="modal-msg">${esc(message)}</div>
      <div class="btnrow"><button class="primary" id="m_ok">${esc(okText)}</button></div>
    </div>`;
    const done = () => { el.className = 'modal-scrim'; el.innerHTML = ''; resolve(); };
    el.querySelector('#m_ok').onclick = done;
    el.onclick = (e) => { if (e.target === el) done(); };
  });
}
