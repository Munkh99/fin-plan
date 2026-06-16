// Low-level DOM plumbing shared by the view modules: root element refs, the
// modal/sheet scrim, toasts, in-app dialogs, the theme toggle, and the small
// bag of mutable UI runtime state (V). Depends only on constants + state, so it
// sits below the view layer in the dependency graph.

import { esc, THEMEKEY, PHOTOKEY } from './constants.js';
import { nowMonth } from './state.js';

// Profile photo cached at sign-in so the avatar can render on the optimistic
// boot — before auth resolves — instead of briefly showing the gear fallback.
export function getCachedPhoto() { try { return localStorage.getItem(PHOTOKEY) || ''; } catch (e) { return ''; } }

// ── Shared UI runtime state ────────────────────────────────────────────────────
// Kept on one object so the view modules can read/write it without a tangle of
// per-field setters across module boundaries.
export const V = {
  view: 'boot',          // 'boot' | 'login' | 'onboarding' | 'shell'
  activeTab: 'overview', // current bottom-nav tab
  spendMonth: nowMonth(),// month shown on the Spending tab
  spendQuery: '',        // all-time search query on the Spending tab
  lastCat: 'food',       // category to pre-select in the add-spend sheet
  booted: false,         // has the first render happened?
};

// ── Root elements ───────────────────────────────────────────────────────────────
export const appEl = document.getElementById('app');
export const scrim = document.getElementById('scrim');
export function closeSheet() { scrim.classList.remove('open'); scrim.innerHTML = ''; }
scrim.onclick = (e) => { if (e.target === scrim) closeSheet(); };

// ── Theme (light / dark) ──────────────────────────────────────────────────────
export function getTheme() {
  try { const saved = localStorage.getItem(THEMEKEY); if (saved) return saved; } catch (e) {}
  // No saved choice yet → follow the device's color scheme at startup.
  try { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'; } catch (e) {}
  return 'light';
}
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

// Themed calendar day-picker. Resolves to a 'YYYY-MM-DD' string, or null if
// dismissed. Built in our own markup (not <input type=date>) so it follows the
// in-app light/dark theme on every platform — including iOS, where the native
// picker ignores CSS and follows the phone's system appearance instead.
export function pickDate(current, max) {
  return new Promise((resolve) => {
    let el = document.getElementById('modal');
    if (!el) { el = document.createElement('div'); el.id = 'modal'; document.body.appendChild(el); }
    const maxD = max ? new Date(max + 'T12:00:00') : null;
    let view = new Date((current || max || '') + 'T12:00:00');
    if (isNaN(view.getTime())) view = new Date();
    view.setDate(1);
    const sel = current || '';
    const done = (v) => { el.className = 'modal-scrim'; el.innerHTML = ''; resolve(v); };
    const render = () => {
      const y = view.getFullYear(), m = view.getMonth();
      const startDow = new Date(y, m, 1).getDay();
      const days = new Date(y, m + 1, 0).getDate();
      const title = view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const canNext = !(maxD && (y > maxD.getFullYear() || (y === maxD.getFullYear() && m >= maxD.getMonth())));
      let cells = '';
      for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty"></div>';
      for (let d = 1; d <= days; d++) {
        const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const disabled = maxD && new Date(y, m, d) > maxD;
        cells += `<button class="cal-cell${ds === sel ? ' sel' : ''}" data-d="${ds}"${disabled ? ' disabled' : ''}>${d}</button>`;
      }
      el.className = 'modal-scrim open';
      el.innerHTML = `<div class="modal-box cal">
        <div class="cal-head">
          <button class="cal-nav" id="cal_prev" aria-label="Previous month">‹</button>
          <div class="cal-title">${title}</div>
          <button class="cal-nav" id="cal_next" aria-label="Next month"${canNext ? '' : ' disabled'}>›</button>
        </div>
        <div class="cal-dow">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<div>${x}</div>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="btnrow"><button class="ghost" id="cal_cancel">Cancel</button></div>
      </div>`;
      el.querySelector('#cal_prev').onclick = () => { view = new Date(y, m - 1, 1); render(); };
      const nx = el.querySelector('#cal_next'); if (canNext) nx.onclick = () => { view = new Date(y, m + 1, 1); render(); };
      el.querySelector('#cal_cancel').onclick = () => done(null);
      el.querySelectorAll('.cal-cell[data-d]').forEach((b) => { if (!b.disabled) b.onclick = () => done(b.dataset.d); });
      el.onclick = (e) => { if (e.target === el) done(null); };
    };
    render();
  });
}
