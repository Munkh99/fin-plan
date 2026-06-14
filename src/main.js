import './style.css';
import { auth, db, provider, configured } from './firebase.js';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth';
import {
  doc,
  collection,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
  getDoc,
  serverTimestamp,
  deleteField,
} from 'firebase/firestore';

// ── Constants ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'food',      label: 'Food',      icon: '🍔', color: '#C2410C' },
  { id: 'transport', label: 'Transport', icon: '🚌', color: '#0369A1' },
  { id: 'shopping',  label: 'Shopping',  icon: '🛍', color: '#7C3AED' },
  { id: 'bills',     label: 'Bills',     icon: '⚡', color: '#B45309' },
  { id: 'health',    label: 'Health',    icon: '💊', color: '#147A5C' },
  { id: 'fun',       label: 'Fun',       icon: '🎬', color: '#BE185D' },
  { id: 'housing',   label: 'Housing',   icon: '🏠', color: '#2B2D77' },
  { id: 'other',     label: 'Other',     icon: '✦',  color: '#566072' },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const PALETTE = ['#C2410C', '#147A5C', '#2B2D77', '#566072', '#7C3AED', '#B45309', '#0369A1', '#BE185D'];
const BASE = 2026 * 12 + 5;

const KEY = 'finplan_v2';
const UIDKEY = 'finplan_uid';
const SCHEMA = 2;

let currentUser = null;
let syncState = 'idle';

// ── Escaping ──────────────────────────────────────────────────────────────────
// Escape any user-supplied string before it enters an innerHTML template or an
// HTML attribute value. Prevents XSS / attribute-breakout from loan names,
// goal names, spend notes, and profile fields.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// ── State ─────────────────────────────────────────────────────────────────────
function defaults() {
  const now = new Date();
  return {
    onboarded: false,
    income: 0,
    budget: 0,
    loans: {},
    loanOrder: [],
    savings: {},
    savingsOrder: [],
    spends: [],
    cursor: 0,
    startAbs: now.getFullYear() * 12 + now.getMonth() - BASE,
    history: [],
    catBudgets: {},   // { categoryId: monthly limit }
  };
}
let S = defaults();

// Normalises any local/imported state object to the current in-memory shape.
function migrate(s) {
  if (!s) return s;
  if (!s.loanOrder) { s.loanOrder = s.order || []; delete s.order; }
  if (!s.loans) s.loans = {};
  if (!s.savings) s.savings = {};
  if (!s.savingsOrder) s.savingsOrder = [];
  if (!s.spends) s.spends = [];
  if (!s.history) s.history = [];
  if (!s.catBudgets) s.catBudgets = {};
  if (s.budget === undefined) s.budget = s.expenses || 0;
  if (s.onboarded === undefined) s.onboarded = !!(s.loanOrder && s.loanOrder.length > 0);
  const typeMap = { toki: 'revolving', inst: 'fixed' };
  for (const id of s.loanOrder || []) {
    const l = s.loans && s.loans[id];
    if (!l) continue;
    if (typeMap[l.type]) l.type = typeMap[l.type];
    if (!l.color) l.color = PALETTE[(s.loanOrder || []).indexOf(id) % PALETTE.length];
    if (!l.orig && l.bal) l.orig = l.bal;
  }
  return s;
}

// ── Local cache (instant optimistic boot) ─────────────────────────────────────
function loadLocal() {
  try { const v = localStorage.getItem(KEY); if (v) return JSON.parse(v); } catch (e) {}
  return null;
}
function persistLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
}

// ── Firestore references ──────────────────────────────────────────────────────
const userDoc  = () => doc(db, 'users', currentUser.uid);
const loanDoc  = (id) => doc(db, 'users', currentUser.uid, 'loans', id);
const savDoc   = (id) => doc(db, 'users', currentUser.uid, 'savings', id);
const spendDoc = (id) => doc(db, 'users', currentUser.uid, 'spends', id);
const loansCol  = () => collection(db, 'users', currentUser.uid, 'loans');
const savCol    = () => collection(db, 'users', currentUser.uid, 'savings');
const spendsCol = () => collection(db, 'users', currentUser.uid, 'spends');

function settingsPayload() {
  return {
    income: S.income,
    budget: S.budget,
    onboarded: S.onboarded,
    cursor: S.cursor,
    startAbs: S.startAbs,
    loanOrder: S.loanOrder,
    savingsOrder: S.savingsOrder,
    history: S.history,
    catBudgets: S.catBudgets,
    schema: SCHEMA,
    updatedAt: serverTimestamp(),
  };
}

async function trackSync(p) {
  syncState = 'syncing'; updateSyncDot();
  try { await p; syncState = 'idle'; }
  catch (e) { syncState = 'error'; }
  updateSyncDot();
}

const canWrite = () => !!(db && currentUser);

// Per-entity writes. Local cache is updated synchronously; Firestore in the
// background. Concurrent edits to different entities never clobber each other.
function persistSettings() {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(userDoc(), settingsPayload(), { merge: true }));
}
function persistLoan(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(loanDoc(id), S.loans[id]));
}
function persistSav(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(savDoc(id), S.savings[id]));
}
function persistSpend(id) {
  persistLocal();
  if (!canWrite()) return;
  const rec = S.spends.find((x) => x.id === id);
  if (!rec) return;
  const { id: _omit, ...data } = rec;
  trackSync(setDoc(spendDoc(id), data));
}
function persistSpendDelete(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(deleteDoc(spendDoc(id)));
}
function addLoan(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.set(loanDoc(id), S.loans[id]);
  b.set(userDoc(), { loanOrder: S.loanOrder, schema: SCHEMA, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
function deleteLoanFull(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.delete(loanDoc(id));
  b.set(userDoc(), { loanOrder: S.loanOrder, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
function addSav(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.set(savDoc(id), S.savings[id]);
  b.set(userDoc(), { savingsOrder: S.savingsOrder, schema: SCHEMA, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
function deleteSavFull(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.delete(savDoc(id));
  b.set(userDoc(), { savingsOrder: S.savingsOrder, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
// Month log / undo: balances + goal totals + history + cursor change together.
function persistMonthChange() {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  for (const id of S.loanOrder) if (S.loans[id]) b.set(loanDoc(id), S.loans[id]);
  for (const id of S.savingsOrder) if (S.savings[id]) b.set(savDoc(id), S.savings[id]);
  b.set(userDoc(), { history: S.history, cursor: S.cursor, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
// Firestore batches cap at 500 writes; chunk for reset/import.
async function runChunked(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = writeBatch(db);
    for (const fn of ops.slice(i, i + 450)) fn(b);
    await b.commit();
  }
}
function resetAll() {
  const loanIds = Object.keys(S.loans);
  const savIds = Object.keys(S.savings);
  const spendIds = S.spends.map((s) => s.id);
  S = defaults();
  persistLocal();
  if (!canWrite()) return;
  const ops = [];
  loanIds.forEach((id) => ops.push((b) => b.delete(loanDoc(id))));
  savIds.forEach((id) => ops.push((b) => b.delete(savDoc(id))));
  spendIds.forEach((id) => ops.push((b) => b.delete(spendDoc(id))));
  ops.push((b) => b.set(userDoc(), settingsPayload()));
  trackSync(runChunked(ops));
}
// One-time upgrade: legacy single-blob doc { payload } → per-entity docs.
async function migrateRemoteIfNeeded() {
  if (!canWrite()) return;
  try {
    const snap = await getDoc(userDoc());
    const d = snap.exists() ? snap.data() : null;
    if (!d || !d.payload || d.schema === SCHEMA) return;
    const parsed = migrate(JSON.parse(d.payload));
    const ops = [];
    for (const id of Object.keys(parsed.loans || {})) ops.push((b) => b.set(loanDoc(id), parsed.loans[id]));
    for (const id of Object.keys(parsed.savings || {})) ops.push((b) => b.set(savDoc(id), parsed.savings[id]));
    for (const sp of parsed.spends || []) { const { id: _o, ...rest } = sp; ops.push((b) => b.set(spendDoc(sp.id), rest)); }
    ops.push((b) => b.set(userDoc(), {
      income: parsed.income || 0,
      budget: parsed.budget || 0,
      onboarded: !!parsed.onboarded,
      cursor: parsed.cursor || 0,
      startAbs: parsed.startAbs,
      loanOrder: parsed.loanOrder || [],
      savingsOrder: parsed.savingsOrder || [],
      history: parsed.history || [],
      schema: SCHEMA,
      payload: deleteField(),
      updatedAt: serverTimestamp(),
    }, { merge: true }));
    await runChunked(ops);
    S = parsed;
    persistLocal();
    reconcile();
  } catch (e) {}
}

// ── Real-time listeners ───────────────────────────────────────────────────────
let unsubs = [];
function detachListeners() { unsubs.forEach((u) => u()); unsubs = []; }
function attachListeners() {
  detachListeners();
  unsubs.push(onSnapshot(userDoc(), (snap) => {
    const d = snap.data();
    if (!d) return;
    // Legacy single-blob doc — ignore until migrateRemoteIfNeeded() converts it,
    // otherwise we'd wipe the view to empty before the real fields are written.
    if (d.payload && d.schema !== SCHEMA) return;
    S.income = d.income || 0;
    S.budget = d.budget || 0;
    S.onboarded = !!d.onboarded;
    S.cursor = d.cursor || 0;
    if (typeof d.startAbs === 'number') S.startAbs = d.startAbs;
    S.loanOrder = d.loanOrder || [];
    S.savingsOrder = d.savingsOrder || [];
    S.history = d.history || [];
    S.catBudgets = d.catBudgets || {};
    reconcile();
  }, () => {}));
  unsubs.push(onSnapshot(loansCol(), (snap) => {
    const m = {}; snap.forEach((dc) => { m[dc.id] = dc.data(); }); S.loans = m; reconcile();
  }, () => {}));
  unsubs.push(onSnapshot(savCol(), (snap) => {
    const m = {}; snap.forEach((dc) => { m[dc.id] = dc.data(); }); S.savings = m; reconcile();
  }, () => {}));
  unsubs.push(onSnapshot(spendsCol(), (snap) => {
    const a = []; snap.forEach((dc) => a.push({ id: dc.id, ...dc.data() })); S.spends = a; reconcile();
  }, () => {}));
}

// Re-render the right view when remote data lands. Modals live in #scrim and are
// untouched; only the underlying view (#content) is refreshed.
let view = 'boot';
function reconcile() {
  persistLocal();
  if (!currentUser) return;
  if (!S.onboarded) {
    if (view !== 'onboarding') { view = 'onboarding'; renderOnboarding(); }
  } else if (view !== 'shell') {
    view = 'shell'; renderShell();
  } else {
    renderContent();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => '₮' + Math.round(n).toLocaleString('en-US');
const fmtShort = (n) => {
  n = Math.round(n);
  return n >= 1e6 ? '₮' + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M'
    : n >= 1e3 ? '₮' + (n / 1e3).toFixed(0) + 'k'
    : '₮' + n.toLocaleString('en-US');
};
const monthLabel = (abs) => { const t = BASE + abs; return `${Math.floor(t / 12)}.${String((t % 12) + 1).padStart(2, '0')}`; };
const lc = (id) => (S.loans[id] && S.loans[id].color) || '#566072';
const sc = (id) => (S.savings[id] && S.savings[id].color) || '#0369A1';
const ord = (d) => d + (d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th');
const nextColor = (order) => PALETTE[order.length % PALETTE.length];
const getInt = (id) => parseInt((document.getElementById(id).value || '').replace(/[^\d]/g, '')) || 0;

function nowMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthDisplay(ym) {
  const [y, m] = ym.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m) - 1]} ${y}`;
}
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function nextMonthStr(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// ── Finance ───────────────────────────────────────────────────────────────────
function cloneLoans() {
  const L = {}; for (const k in S.loans) L[k] = { ...S.loans[k] }; return L;
}
function plannedLoans(L) {
  const out = {};
  for (const id of S.loanOrder) {
    const l = L[id]; if (!l || l.bal <= 0.5) { out[id] = 0; continue; }
    if (l.type === 'fixed') out[id] = Math.min(l.plan, l.bal * (1 + l.rate));
  }
  const rev = S.loanOrder.filter((id) => L[id] && L[id].bal > 0.5 && L[id].type === 'revolving');
  const mins = {};
  for (const id of rev) { const l = L[id]; mins[id] = l.bal * l.rate + l.bal * 0.10; }
  const fixedSum = S.loanOrder.reduce((s, id) => (out[id] || 0) + s, 0);
  const minSum = rev.reduce((s, id) => mins[id] + s, 0);
  let surplus = Math.max(0, (S.income - S.budget) - fixedSum - minSum);
  for (let i = 0; i < rev.length; i++) { const id = rev[i], l = L[id]; out[id] = Math.min(l.bal * (1 + l.rate), i === 0 ? mins[id] + surplus : mins[id]); }
  return out;
}
function totalSavingsContrib() {
  return S.savingsOrder.reduce((s, id) => { const sv = S.savings[id]; return (!sv || sv.current >= sv.target) ? s : s + sv.monthly; }, 0);
}
function freeCash() {
  const lp = plannedLoans(cloneLoans());
  return S.income - S.budget - S.loanOrder.reduce((s, id) => s + (lp[id] || 0), 0) - totalSavingsContrib();
}
function simulateLoans() {
  const L = cloneLoans(); const snaps = []; let guard = 0, abs = S.startAbs + S.cursor, totalInt = 0;
  const any = () => S.loanOrder.some((id) => L[id] && L[id].bal > 0.5);
  const hasPlan = () => S.loanOrder.some((id) => { const l = L[id]; if (!l || l.bal <= 0.5) return false; return l.type === 'revolving' || (l.type === 'fixed' && l.plan > 0); });
  while (any() && guard < 1200 && hasPlan()) {
    snaps.push({ abs, bals: Object.fromEntries(S.loanOrder.map((id) => [id, L[id] ? L[id].bal : 0])) });
    const plan = plannedLoans(L);
    if (S.loanOrder.reduce((s, id) => s + (plan[id] || 0), 0) <= 0) break;
    for (const id of S.loanOrder) { const l = L[id]; if (!l || l.bal <= 0.5) { if (l) l.bal = 0; continue; } totalInt += l.bal * l.rate; l.bal = Math.max(0, l.bal * (1 + l.rate) - (plan[id] || 0)); }
    abs++; guard++;
  }
  snaps.push({ abs, bals: Object.fromEntries(S.loanOrder.map((id) => [id, L[id] ? Math.max(0, L[id].bal) : 0])) });
  return { snaps, months: guard, totalInt, payoffAbs: S.startAbs + S.cursor + Math.max(0, guard - 1) };
}
function savMonthsToGoal(id) { const sv = S.savings[id]; if (!sv) return null; const rem = sv.target - sv.current; if (rem <= 0) return 0; if (sv.monthly <= 0) return null; return Math.ceil(rem / sv.monthly); }

// ── Spending helpers ──────────────────────────────────────────────────────────
function spendsForMonth(ym) { return S.spends.filter((sp) => sp.month === ym); }
function totalForMonth(ym) { return spendsForMonth(ym).reduce((s, sp) => s + sp.amount, 0); }
function byCategory(ym) {
  const totals = {};
  for (const sp of spendsForMonth(ym)) totals[sp.category] = (totals[sp.category] || 0) + sp.amount;
  return totals;
}
// Last `n` months (oldest→newest) with their spend totals, for the trend chart.
function lastMonthsTotals(n) {
  const arr = [];
  let ym = nowMonth();
  for (let i = 0; i < n; i++) { arr.unshift({ ym, total: totalForMonth(ym) }); ym = prevMonth(ym); }
  return arr;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dateStrFromTs = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const appEl = document.getElementById('app');
const scrim = document.getElementById('scrim');
function closeSheet() { scrim.classList.remove('open'); scrim.innerHTML = ''; }
scrim.onclick = (e) => { if (e.target === scrim) closeSheet(); };

let activeTab = 'overview';
let spendMonth = nowMonth();
let lastCat = 'food';

// ── Shell ───────────────────────────────────────────────────────────────────
function renderShell() {
  appEl.innerHTML = `
    <div class="topbar-wrap">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="title">Fin Plan</div>
        <span class="sync-dot" id="syncDot"></span>
      </div>
      <div id="topbar-right"></div>
    </div>
    <div class="content" id="content"></div>
    <nav class="tabbar">
      <button class="tab-btn${activeTab === 'overview' ? ' active' : ''}" data-tab="overview">
        <span class="tab-icon">📊</span>Overview
      </button>
      <button class="tab-btn${activeTab === 'spending' ? ' active' : ''}" data-tab="spending">
        <span class="tab-icon">💸</span>Spending
      </button>
      <button class="tab-btn${activeTab === 'loans' ? ' active' : ''}" data-tab="loans">
        <span class="tab-icon">🏦</span>Loans
      </button>
      <button class="tab-btn${activeTab === 'savings' ? ' active' : ''}" data-tab="savings">
        <span class="tab-icon">💰</span>Savings
      </button>
    </nav>
    <button class="fab" id="fab" title="Add spending">＋</button>`;

  appEl.querySelectorAll('.tab-btn').forEach((btn) => (btn.onclick = () => {
    activeTab = btn.dataset.tab;
    appEl.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    renderContent();
    updateFab();
  }));
  renderTopbarRight();
  renderContent();
  updateFab();
  updateSyncDot();
}

// The FAB does the most relevant "add" for the current tab.
function updateFab() {
  const fab = document.getElementById('fab');
  if (!fab) return;
  const map = {
    overview: { t: 'Add spending', fn: () => openAddSpend() },
    spending: { t: 'Add spending', fn: () => openAddSpend() },
    loans:    { t: 'Add loan',     fn: () => openLoanForm(null, renderContent) },
    savings:  { t: 'Add savings goal', fn: () => openSavingsForm(null, renderContent) },
  };
  const m = map[activeTab] || map.overview;
  fab.title = m.t;
  fab.onclick = m.fn;
}

function renderTopbarRight() {
  const el = document.getElementById('topbar-right');
  if (!el) return;
  if (currentUser && currentUser.photoURL) {
    el.innerHTML = `<img class="avatar" id="settingsBtn" src="${esc(currentUser.photoURL)}" alt="">`;
  } else {
    el.innerHTML = `<button class="iconbtn" id="settingsBtn">⚙</button>`;
  }
  document.getElementById('settingsBtn').onclick = openSettings;
}

function renderContent() {
  const el = document.getElementById('content');
  if (!el) return;
  if (activeTab === 'overview') renderOverview(el);
  else if (activeTab === 'spending') renderSpending(el);
  else if (activeTab === 'loans') renderLoans(el);
  else if (activeTab === 'savings') renderSavingsTab(el);
}

function updateSyncDot() {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot' + (syncState === 'syncing' ? ' syncing' : '');
  dot.title = syncState === 'idle' ? 'Synced' : syncState === 'syncing' ? 'Saving…' : 'Sync error';
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function renderOverview(el) {
  const ym = nowMonth();
  const spent = totalForMonth(ym);
  const pct = S.budget > 0 ? Math.min(100, (spent / S.budget) * 100) : 0;
  const left = S.budget - spent;
  const free = freeCash();
  const cats = byCategory(ym);
  const topCats = CATEGORIES.filter((c) => cats[c.id]).sort((a, b) => cats[b.id] - cats[a.id]).slice(0, 4);
  const totalDebt = S.loanOrder.reduce((s, id) => s + (S.loans[id] ? S.loans[id].bal : 0), 0);
  const totalSaved = S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].current : 0), 0);
  const sim = S.loanOrder.length ? simulateLoans() : null;
  const barColor = pct > 90 ? '#f87171' : pct > 70 ? '#FCD34D' : '#7BE3C0';
  const leftCls = left < 0 ? 'bad' : left < S.budget * 0.1 ? 'warn' : 'good';

  let h = `<div class="hero">
    <div class="eyebrow">${monthDisplay(ym)} · spending</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px">
      <div>
        <div style="font-size:10px;color:#9aa0ad;margin-bottom:2px">Spent</div>
        <div class="amount mono" style="font-size:28px">${fmtShort(spent)}</div>
        <div style="font-size:11px;color:#9aa0ad">of ${fmtShort(S.budget)} budget</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:10px;color:#9aa0ad;margin-bottom:2px">Left</div>
        <div class="amount ${leftCls}">${left < 0 ? '−' : ''}${fmtShort(Math.abs(left))}</div>
      </div>
    </div>
    <div class="bar" style="margin-top:12px"><span style="width:${pct}%;background:${barColor}"></span></div>
  </div>`;

  if (topCats.length) {
    h += `<div style="background:var(--card);border-radius:14px;padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)">
      <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;margin-bottom:8px">Top spending</div>`;
    for (const c of topCats) {
      const amt = cats[c.id] || 0;
      const barW = spent > 0 ? Math.round((amt / spent) * 100) : 0;
      h += `<div class="cat-row">
        <div class="icon" style="background:${c.color}22">${c.icon}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between">
            <span class="label" style="font-size:12px">${c.label}</span>
            <span style="font-size:12px;font-weight:600;font-variant-numeric:tabular-nums">${fmtShort(amt)}</span>
          </div>
          <div class="cat-bar-wrap" style="margin-top:3px"><span style="width:${barW}%;background:${c.color}"></span></div>
        </div>
      </div>`;
    }
    h += `</div>`;
  } else {
    h += `<div style="background:var(--card);border-radius:14px;padding:20px 16px;text-align:center;margin-bottom:12px;box-shadow:var(--shadow)">
      <div style="font-size:22px;margin-bottom:8px">💸</div>
      <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:14px;margin-bottom:4px">No spending logged yet</div>
      <div style="font-size:12px;color:var(--soft)">Tap ＋ to add your first entry</div>
    </div>`;
  }

  h += `<div class="summary-grid">`;
  h += `<div class="sum-card" id="goLoans">
    <div class="k">Loans</div>
    <div class="v mono">${totalDebt > 0 ? fmtShort(totalDebt) : 'Clear'}</div>
    <div class="sub">${sim && sim.months > 0 ? `${sim.months} payments left` : S.loanOrder.length ? 'All paid' : 'No loans'}</div>
  </div>`;
  h += `<div class="sum-card" id="goSavings">
    <div class="k">Savings</div>
    <div class="v mono">${fmtShort(totalSaved)}</div>
    <div class="sub">${S.savingsOrder.length ? `${S.savingsOrder.length} goal${S.savingsOrder.length > 1 ? 's' : ''}` : ' No goals'}</div>
  </div>`;
  h += `</div>`;

  // Net worth (savings − debt)
  if (S.savingsOrder.length || S.loanOrder.length) {
    const net = totalSaved - totalDebt;
    h += `<div class="networth">
      <div><div class="k">Net worth</div><div class="sub" style="text-align:left;margin-top:2px">Savings ${fmtShort(totalSaved)} − Debt ${fmtShort(totalDebt)}</div></div>
      <div class="v ${net >= 0 ? 'good' : 'bad'}">${net < 0 ? '−' : ''}${fmtShort(Math.abs(net))}</div>
    </div>`;
  }

  // 6-month spending trend
  if (S.spends.length) h += trendCard();

  const plannedTotal = S.loanOrder.reduce((s, id) => s + (plannedLoans(cloneLoans())[id] || 0), 0);
  h += `<div style="background:var(--card);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow);margin-bottom:4px">
    <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;margin-bottom:10px">Monthly breakdown</div>
    ${row('Income', S.income, '#7BE3C0')}
    ${row('Living budget', S.budget, '#9aa0ad')}
    ${plannedTotal > 0 ? row('Loans', plannedTotal, '#9aa0ad') : ''}
    ${totalSavingsContrib() > 0 ? row('Savings', totalSavingsContrib(), '#9aa0ad') : ''}
    <div style="height:1px;background:var(--rule);margin:8px 0"></div>
    ${row('Free cash', free, free >= 0 ? '#7BE3C0' : '#f87171')}
  </div>`;

  el.innerHTML = h;
  const goL = document.getElementById('goLoans');
  const goS = document.getElementById('goSavings');
  if (goL) goL.onclick = () => { activeTab = 'loans'; renderShell(); };
  if (goS) goS.onclick = () => { activeTab = 'savings'; renderShell(); };
}

function row(label, amount, color) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
    <span style="font-size:12px;color:var(--soft)">${label}</span>
    <span style="font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:${color}">${fmt(amount)}</span>
  </div>`;
}

function trendCard() {
  const data = lastMonthsTotals(6);
  const max = Math.max(...data.map((d) => d.total), 1);
  const ML = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const cur = nowMonth();
  const bars = data.map((d) => {
    const hpct = Math.round((d.total / max) * 100);
    const m = parseInt(d.ym.split('-')[1]) - 1;
    return `<div class="tb${d.ym === cur ? ' cur' : ''}">
      <div class="tb-v">${d.total ? fmtShort(d.total) : ''}</div>
      <div class="tb-bar"><span style="height:${hpct}%"></span></div>
      <div class="tb-l">${ML[m]}</div>
    </div>`;
  }).join('');
  return `<div class="trend-card"><div class="trend-h">6-month spending</div><div class="trend-bars">${bars}</div></div>`;
}

// ── Spending tab ──────────────────────────────────────────────────────────────
function renderSpending(el) {
  const items = spendsForMonth(spendMonth);
  const total = items.reduce((s, sp) => s + sp.amount, 0);
  const cats = byCategory(spendMonth);
  const isNow = spendMonth === nowMonth();

  const byDay = {};
  for (const sp of [...items].sort((a, b) => b.ts - a.ts)) {
    const d = new Date(sp.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (byDay[key] = byDay[key] || []).push(sp);
  }

  let h = `<div class="month-nav">
    <button id="mn_prev">‹</button>
    <div class="label">${monthDisplay(spendMonth)}</div>
    <button id="mn_next" ${isNow ? 'style="opacity:.3;pointer-events:none"' : ''}>›</button>
  </div>`;

  if (items.length === 0) {
    h += `<div class="empty">No spending in ${monthDisplay(spendMonth)}.<br>Tap ＋ to add an entry.</div>`;
  } else {
    h += `<div style="background:var(--card);border-radius:14px;padding:13px 16px;margin-bottom:14px;box-shadow:var(--shadow);display:flex;justify-content:space-between;align-items:center">
      <div><div style="font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em">Total spent</div>
        <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:26px">${fmt(total)}</div></div>
      ${S.budget > 0 ? `<div style="text-align:right">
        <div style="font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em">Budget</div>
        <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:18px;color:${total > S.budget ? 'var(--danger)' : 'var(--emerald)'}">${fmtShort(S.budget)}</div>
      </div>` : ''}
    </div>`;

    const sortedCats = CATEGORIES.filter((c) => cats[c.id]).sort((a, b) => cats[b.id] - cats[a.id]);
    if (sortedCats.length) {
      h += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">`;
      for (const c of sortedCats) {
        const b = S.catBudgets[c.id];
        const over = b && cats[c.id] > b;
        h += `<div style="display:flex;align-items:center;gap:5px;background:var(--card);border-radius:20px;padding:5px 10px;font-size:11px;box-shadow:var(--shadow);${over ? 'color:var(--danger)' : ''}">
          <span>${c.icon}</span><span style="font-weight:600">${fmtShort(cats[c.id])}${b ? ` / ${fmtShort(b)}` : ''}</span>${over ? ' ⚠' : ''}
        </div>`;
      }
      h += `</div>`;
    }

    if (items.length >= 6) {
      h += `<input class="search-input" id="sp_search" placeholder="🔍 Search notes or category…">`;
    }

    for (const dayKey of Object.keys(byDay)) {
      const d = new Date(dayKey + 'T12:00:00');
      const todayKey = new Date().toISOString().slice(0, 10);
      const yesterdayKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const dayLabel = dayKey === todayKey ? 'Today' : dayKey === yesterdayKey ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      h += `<div class="day-group"><div class="day-label">${dayLabel}</div>`;
      for (const sp of byDay[dayKey]) {
        const c = CAT[sp.category] || CAT.other;
        const note = esc(sp.note);
        const hay = esc(((sp.note || '') + ' ' + c.label).toLowerCase());
        h += `<div class="spend-item" data-spend="${esc(sp.id)}" data-search="${hay}">
          <div class="cat-icon" style="background:${c.color}22">${c.icon}</div>
          <div class="info">
            <div class="name">${note || c.label}</div>
            <div class="meta">${c.label}${sp.note && sp.note !== c.label ? ' · ' + note : ''}</div>
          </div>
          <div class="amt">${fmt(sp.amount)}</div>
        </div>`;
      }
      h += `</div>`;
    }
  }

  el.innerHTML = h;
  document.getElementById('mn_prev').onclick = () => { spendMonth = prevMonth(spendMonth); renderContent(); };
  document.getElementById('mn_next').onclick = () => { spendMonth = nextMonthStr(spendMonth); renderContent(); };
  el.querySelectorAll('[data-spend]').forEach((item) => (item.onclick = () => openEditSpend(item.dataset.spend)));
  const search = document.getElementById('sp_search');
  if (search) search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    el.querySelectorAll('[data-spend]').forEach((item) => {
      const hay = item.getAttribute('data-search') || '';
      item.style.display = !q || hay.includes(q) ? '' : 'none';
    });
    // Hide day headers whose entries are all filtered out.
    el.querySelectorAll('.day-group').forEach((g) => {
      const anyVisible = [...g.querySelectorAll('[data-spend]')].some((i) => i.style.display !== 'none');
      g.style.display = anyVisible ? '' : 'none';
    });
  };
}

// ── Loans tab ───────────────────────────────────────────────────────────────
function renderLoans(el) {
  const plan = plannedLoans(cloneLoans());
  const sim = S.loanOrder.length ? simulateLoans() : null;
  let h = `<div class="seclabel"><div class="t">Loans</div>
    <button class="ghost" id="addLoanBtn" style="flex:0 0 auto;padding:6px 12px;font-size:12px;border-radius:10px">＋ Add</button>
  </div>`;

  if (!S.loanOrder.length) {
    h += `<div class="empty">No loans tracked.<br>Tap + Add to get started.</div>`;
  } else {
    const totalDebt = S.loanOrder.reduce((s, id) => s + (S.loans[id] ? S.loans[id].bal : 0), 0);
    h += `<div class="hero" style="margin-bottom:12px">
      <div class="eyebrow">Total debt</div>
      <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:32px;color:#fff;margin-top:4px">${fmt(totalDebt)}</div>
      ${sim ? `<div style="font-size:12px;color:#9aa0ad;margin-top:4px">Debt-free by <b style="color:#7BE3C0">${monthLabel(sim.payoffAbs)}</b> · ${sim.months} payments left</div>` : ''}
    </div>`;
    for (const id of S.loanOrder) {
      const l = S.loans[id]; if (!l) continue;
      const done = l.bal <= 0.5;
      const prog = l.orig > 0 ? Math.min(100, (1 - l.bal / l.orig) * 100) : 0;
      const ratePct = (l.rate * 100).toFixed(2).replace(/\.?0+$/, '') + '%/mo';
      h += `<div class="loan${done ? ' done' : ''}" style="--ac:${lc(id)}" data-loan="${esc(id)}">
        <div class="top">
          <div class="name"><span class="dot"></span>${esc(l.name)}</div>
          <div class="tags">
            ${done ? '<span class="donetag">✓ Paid</span>' : `<span class="tag">${ratePct}</span>`}
            ${l.payDay ? `<span class="tag">due ${ord(l.payDay)}</span>` : ''}
            <span class="chev">›</span>
          </div>
        </div>
        ${!done ? `<div class="balrow">
          <div><div style="font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em">Balance</div>
            <div class="bal mono">${fmt(l.bal)}</div></div>
          <div class="plan">pay this month<b class="mono">${fmt(plan[id] || 0)}</b></div></div>
        <div class="lprog"><span style="width:${prog}%"></span></div>` : ''}
      </div>`;
    }
    h += `<div class="btnrow" style="margin-top:4px">
      <button class="ghost" id="logLoansBtn">📋 Log this month's payments</button>
      ${S.cursor > 0 ? '<button class="ghost" id="undoBtn" style="flex:0 0 auto">↩</button>' : ''}
    </div>`;
  }
  el.innerHTML = h;
  document.getElementById('addLoanBtn').onclick = () => openLoanForm(null, renderContent);
  el.querySelectorAll('[data-loan]').forEach((e) => (e.onclick = () => openLoanDetail(e.dataset.loan)));
  const logBtn = document.getElementById('logLoansBtn');
  if (logBtn) logBtn.onclick = openLogLoans;
  const undoBtn = document.getElementById('undoBtn');
  if (undoBtn) undoBtn.onclick = undo;
}

// ── Savings tab ───────────────────────────────────────────────────────────────
function renderSavingsTab(el) {
  const totalSaved = S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].current : 0), 0);
  const totalTarget = S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].target : 0), 0);
  let h = `<div class="seclabel"><div class="t">Savings goals</div>
    <button class="ghost" id="addSavBtn" style="flex:0 0 auto;padding:6px 12px;font-size:12px;border-radius:10px">＋ Add</button>
  </div>`;
  if (!S.savingsOrder.length) {
    h += `<div class="empty">No savings goals yet.<br>Tap + Add to create one.</div>`;
  } else {
    h += `<div class="hero" style="margin-bottom:12px">
      <div class="eyebrow">Total saved</div>
      <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:32px;color:#fff;margin-top:4px">${fmt(totalSaved)}</div>
      ${totalTarget > 0 ? `<div style="font-size:12px;color:#9aa0ad;margin-top:4px">toward <b style="color:#7BE3C0">${fmt(totalTarget)}</b> in goals</div>` : ''}
    </div>`;
    for (const id of S.savingsOrder) {
      const sv = S.savings[id]; if (!sv) continue;
      const done = sv.current >= sv.target;
      const prog = sv.target > 0 ? Math.min(100, (sv.current / sv.target) * 100) : 0;
      const months = savMonthsToGoal(id);
      h += `<div class="sav-card${done ? ' done' : ''}" style="--ac:${sc(id)}" data-sav="${esc(id)}">
        <div class="top">
          <div class="name"><span class="dot"></span>${esc(sv.name)}</div>
          <div class="tags">
            ${done ? '<span class="donetag">✓ Done</span>' : `<span class="tag">${fmtShort(sv.monthly)}/mo</span>`}
            <span class="chev">›</span>
          </div>
        </div>
        <div class="balrow">
          <div><div style="font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em">Saved</div>
            <div class="bal mono">${fmt(sv.current)}</div></div>
          <div class="plan">goal<b class="mono">${fmtShort(sv.target)}</b></div>
        </div>
        <div class="lprog"><span style="width:${prog}%"></span></div>
        ${!done && months !== null ? `<div style="font-size:10.5px;color:var(--faint);margin-top:5px">${months} month${months === 1 ? '' : 's'} to goal</div>` : ''}
      </div>`;
    }
  }
  el.innerHTML = h;
  document.getElementById('addSavBtn').onclick = () => openSavingsForm(null, renderContent);
  el.querySelectorAll('[data-sav]').forEach((e) => (e.onclick = () => openSavDetail(e.dataset.sav)));
}

// ── Add spending sheet ─────────────────────────────────────────────────────────
function openAddSpend(prefill) {
  let selCat = (prefill && prefill.category) || lastCat;
  const catGrid = () => CATEGORIES.map((c) => `
    <div class="cat-pick${selCat === c.id ? ' selected' : ''}" data-cat="${c.id}">
      <span class="icon">${c.icon}</span>
      <span class="label">${c.label}</span>
    </div>`).join('');

  scrim.innerHTML = `<div class="sheet">
    <h2>Add spending</h2>
    <div class="amount-prefix">Amount (₮)</div>
    <input class="amount-input" id="sp_amount" inputmode="numeric" placeholder="0" autocomplete="off" value="${prefill ? prefill.amount : ''}">
    <div class="cat-grid" id="cat_grid">${catGrid()}</div>
    <label class="set-label">Note (optional)</label>
    <input class="set-input" id="sp_note" placeholder="e.g. Lunch, Grocery run…" value="${prefill ? esc(prefill.note || '') : ''}">
    <label class="set-label">Date</label>
    <input class="set-input" type="date" id="sp_date" value="${todayStr()}" max="${todayStr()}">
    <div class="btnrow">
      <button class="ghost" id="sp_cancel">Cancel</button>
      <button class="primary" id="sp_save">Add</button>
    </div>
  </div>`;
  scrim.classList.add('open');
  document.getElementById('sp_amount').focus();
  document.getElementById('sp_cancel').onclick = closeSheet;
  scrim.querySelectorAll('.cat-pick').forEach((btn) => { btn.onclick = () => { selCat = btn.dataset.cat; scrim.querySelectorAll('.cat-pick').forEach((b) => b.classList.toggle('selected', b.dataset.cat === selCat)); }; });
  document.getElementById('sp_save').onclick = () => {
    const amount = parseInt((document.getElementById('sp_amount').value || '').replace(/[^\d]/g, '')) || 0;
    if (!amount) { alert('Enter an amount.'); return; }
    const note = (document.getElementById('sp_note').value || '').trim();
    const dateStr = document.getElementById('sp_date').value || todayStr();
    const ts = dateStr === todayStr() ? Date.now() : new Date(dateStr + 'T12:00:00').getTime();
    const ym = dateStr.slice(0, 7);
    const id = 'sp_' + Date.now();
    lastCat = selCat;
    S.spends.push({ id, ts, month: ym, amount, category: selCat, note });
    persistSpend(id); closeSheet(); renderContent();
    toast(`Added ${fmt(amount)} · ${(CAT[selCat] || CAT.other).label}`);
  };
}

function openEditSpend(id) {
  const sp = S.spends.find((x) => x.id === id); if (!sp) return;
  let selCat = sp.category;
  const catGrid = () => CATEGORIES.map((c) => `
    <div class="cat-pick${selCat === c.id ? ' selected' : ''}" data-cat="${c.id}">
      <span class="icon">${c.icon}</span>
      <span class="label">${c.label}</span>
    </div>`).join('');

  scrim.innerHTML = `<div class="sheet">
    <h2>Edit spending</h2>
    <div class="amount-prefix">Amount (₮)</div>
    <input class="amount-input" id="sp_amount" inputmode="numeric" value="${sp.amount}">
    <div class="cat-grid" id="cat_grid">${catGrid()}</div>
    <label class="set-label">Note (optional)</label>
    <input class="set-input" id="sp_note" value="${esc(sp.note || '')}">
    <label class="set-label">Date</label>
    <input class="set-input" type="date" id="sp_date" value="${dateStrFromTs(sp.ts)}" max="${todayStr()}">
    <div class="btnrow">
      <button class="ghost" id="sp_del" style="color:var(--danger)">Delete</button>
      <button class="primary" id="sp_save">Save</button>
    </div>
  </div>`;
  scrim.classList.add('open');
  scrim.querySelectorAll('.cat-pick').forEach((btn) => {
    btn.onclick = () => { selCat = btn.dataset.cat; scrim.querySelectorAll('.cat-pick').forEach((b) => b.classList.toggle('selected', b.dataset.cat === selCat)); };
  });
  document.getElementById('sp_del').onclick = () => {
    if (!confirm('Delete this entry?')) return;
    S.spends = S.spends.filter((x) => x.id !== id);
    persistSpendDelete(id); closeSheet(); renderContent();
    toast('Entry deleted');
  };
  document.getElementById('sp_save').onclick = () => {
    const amount = parseInt((document.getElementById('sp_amount').value || '').replace(/[^\d]/g, '')) || 0;
    if (!amount) { alert('Enter an amount.'); return; }
    const note = (document.getElementById('sp_note').value || '').trim();
    const dateStr = document.getElementById('sp_date').value || dateStrFromTs(sp.ts);
    const ts = new Date(dateStr + 'T12:00:00').getTime();
    const month = dateStr.slice(0, 7);
    const idx = S.spends.findIndex((x) => x.id === id);
    if (idx >= 0) { S.spends[idx] = { ...S.spends[idx], amount, category: selCat, note, ts, month }; }
    persistSpend(id); closeSheet(); renderContent();
    toast('Saved');
  };
}

// ── Loan detail ───────────────────────────────────────────────────────────────
function drawChart(actual, projected, color) {
  const W = 320, H = 150, Lp = 10, Rp = 10, Tp = 12, Bp = 22;
  const all = actual.concat(projected);
  if (all.length < 2) return '<div class="empty">Log a payment to see the trend.</div>';
  const xs = all.map((p) => p.abs), ys = all.map((p) => p.bal);
  const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys, 1);
  const x = (a) => Lp + (maxX === minX ? 0 : (a - minX) / (maxX - minX)) * (W - Lp - Rp);
  const y = (b) => Tp + (1 - b / maxY) * (H - Tp - Bp);
  const path = (arr) => arr.map((p, i) => (i ? 'L' : 'M') + x(p.abs).toFixed(1) + ' ' + y(p.bal).toFixed(1)).join(' ');
  const baseY = y(0);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
  s += `<line x1="${Lp}" y1="${baseY}" x2="${W - Rp}" y2="${baseY}" stroke="var(--rule)" stroke-width="1"/>`;
  if (actual.length >= 2) {
    s += `<path d="${path(actual)} L${x(actual[actual.length - 1].abs).toFixed(1)} ${baseY} L${x(actual[0].abs).toFixed(1)} ${baseY}Z" fill="${color}" opacity="0.08"/>`;
    s += `<path d="${path(actual)}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (projected.length >= 2) s += `<path d="${path(projected)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 4" opacity="0.45"/>`;
  const cur = actual[actual.length - 1];
  s += `<circle cx="${x(cur.abs).toFixed(1)}" cy="${y(cur.bal).toFixed(1)}" r="3.6" fill="${color}"/>`;
  s += `<text x="${Lp}" y="${H - 6}" font-size="9" fill="var(--faint)">${monthLabel(minX)}</text>`;
  s += `<text x="${W - Rp}" y="${H - 6}" font-size="9" fill="var(--faint)" text-anchor="end">${monthLabel(maxX)}</text></svg>`;
  return s;
}

function openLoanDetail(id) {
  const l = S.loans[id]; if (!l) return;
  const actual = [];
  for (let k = 0; k < S.cursor; k++) { const hi = S.history[k]; if (hi && hi.prev && typeof hi.prev[id] === 'number') actual.push({ abs: S.startAbs + k, bal: hi.prev[id] }); }
  actual.push({ abs: S.startAbs + S.cursor, bal: l.bal });
  const sim = simulateLoans();
  const projected = sim.snaps.map((sn) => ({ abs: sn.abs, bal: sn.bals[id] || 0 }));
  let intPaid = 0, paysMade = 0;
  for (let k = 0; k < S.cursor; k++) { const hi = S.history[k]; if (!hi) continue; intPaid += ((hi.prev && hi.prev[id]) || 0) * l.rate; if (hi.pays && hi.pays[id] > 0) paysMade++; }
  const pct = l.orig > 0 ? Math.round((1 - l.bal / l.orig) * 100) : 0;
  const hit = projected.find((p) => p.bal <= 0.5);
  const gone = l.bal <= 0.5 ? 'Paid off' : hit ? monthLabel(hit.abs) : '—';
  const color = lc(id);
  scrim.innerHTML = `<div class="sheet">
    <h2><span class="dot" style="background:${color};width:12px;height:12px;border-radius:50%"></span>${esc(l.name)}</h2>
    <div class="hint">${l.type === 'revolving' ? 'Revolving' : 'Fixed'} · ${(l.rate * 100).toFixed(2)}%/mo${l.payDay ? ` · due ${ord(l.payDay)}` : ''}</div>
    <div class="chartwrap">${drawChart(actual, projected, color)}
      <div class="legend"><span style="color:${color}"><i></i> Actual</span><span style="color:${color}"><i class="dash"></i> Projected</span></div></div>
    <div class="dstat">
      <div><div class="k">Balance</div><div class="v mono">${fmt(l.bal)}</div></div>
      <div><div class="k">Paid off</div><div class="v mono">${pct}%</div></div>
      <div><div class="k">Original</div><div class="v mono">${fmtShort(l.orig)}</div></div>
      <div><div class="k">Interest paid</div><div class="v mono">${fmtShort(intPaid)}</div></div>
      <div><div class="k">Payments made</div><div class="v mono">${paysMade}</div></div>
      <div><div class="k">Gone by</div><div class="v mono">${gone}</div></div>
    </div>
    <div class="btnrow">
      <button class="ghost" id="editLoan">Edit</button>
      <button class="primary" id="closeDet">Close</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('closeDet').onclick = closeSheet;
  document.getElementById('editLoan').onclick = () => { closeSheet(); openLoanForm(id, renderContent); };
}

// ── Savings detail ──────────────────────────────────────────────────────────
function openSavDetail(id) {
  const sv = S.savings[id]; if (!sv) return;
  const done = sv.current >= sv.target;
  const prog = sv.target > 0 ? Math.min(100, (sv.current / sv.target) * 100) : 0;
  const months = savMonthsToGoal(id);
  const color = sc(id);
  scrim.innerHTML = `<div class="sheet">
    <h2><span class="dot" style="background:${color};width:12px;height:12px;border-radius:50%"></span>${esc(sv.name)}</h2>
    <div class="hint">${done ? 'Goal reached!' : 'Saving ' + fmtShort(sv.monthly) + '/month'}</div>
    <div style="background:var(--card);border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="height:8px;border-radius:6px;background:var(--paper);overflow:hidden">
        <div style="height:100%;width:${prog}%;background:${color};border-radius:6px;transition:width .5s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--soft)">
        <span>${fmt(sv.current)} saved</span><span>${Math.round(prog)}% · ${fmt(sv.target)} goal</span>
      </div>
    </div>
    <div class="dstat">
      <div><div class="k">Saved</div><div class="v mono">${fmt(sv.current)}</div></div>
      <div><div class="k">Remaining</div><div class="v mono">${fmt(Math.max(0, sv.target - sv.current))}</div></div>
      <div><div class="k">Monthly</div><div class="v mono">${fmt(sv.monthly)}</div></div>
      <div><div class="k">Reach by</div><div class="v mono">${done ? '✓ Done' : months !== null ? monthLabel(S.startAbs + S.cursor + months) : '—'}</div></div>
    </div>
    <div class="btnrow">
      <button class="ghost" id="editSav">Edit</button>
      <button class="primary" id="closeSav">Close</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('closeSav').onclick = closeSheet;
  document.getElementById('editSav').onclick = () => { closeSheet(); openSavingsForm(id, renderContent); };
}

// ── Loan form ───────────────────────────────────────────────────────────────
function openLoanForm(editId, onDone) {
  const ex = editId ? S.loans[editId] : null;
  scrim.innerHTML = `<div class="sheet">
    <h2>${ex ? 'Edit loan' : 'Add loan'}</h2>
    <label class="set-label">Loan name</label>
    <input class="set-input" id="nl_name" placeholder="e.g. Car loan, Credit card" value="${ex ? esc(ex.name) : ''}">
    <div class="two">
      <div><label class="set-label">Current balance</label>
        <input class="set-input mono" id="nl_bal" inputmode="numeric" placeholder="0" value="${ex ? Math.round(ex.bal).toLocaleString('en-US') : ''}"></div>
      <div><label class="set-label">Rate %/month</label>
        <input class="set-input mono" id="nl_rate" inputmode="decimal" placeholder="1.5" value="${ex ? (ex.rate * 100).toString() : ''}"></div>
    </div>
    <label class="set-label">Type</label>
    <select class="set-input" id="nl_type">
      <option value="fixed" ${!ex || ex.type === 'fixed' ? 'selected' : ''}>Fixed installment (car, mortgage…)</option>
      <option value="revolving" ${ex && ex.type === 'revolving' ? 'selected' : ''}>Revolving / BNPL (10% min)</option>
    </select>
    <div id="nl_plan_row" ${ex && ex.type === 'revolving' ? 'style="display:none"' : ''}>
      <label class="set-label">Monthly payment</label>
      <input class="set-input mono" id="nl_plan" inputmode="numeric" placeholder="0" value="${ex && ex.type === 'fixed' ? Math.round(ex.plan || 0).toLocaleString('en-US') : ''}">
    </div>
    <label class="set-label">Payment due day (1–31, optional)</label>
    <input class="set-input mono" id="nl_day" inputmode="numeric" maxlength="2" placeholder="e.g. 25" style="width:120px" value="${ex && ex.payDay ? ex.payDay : ''}">
    <div class="btnrow">
      ${editId ? `<button class="ghost" id="nl_del" style="color:var(--danger)">Delete</button>` : `<button class="ghost" id="nl_cancel">Cancel</button>`}
      <button class="primary" id="nl_save">${ex ? 'Save changes' : 'Add loan'}</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('nl_type').onchange = (e) => { document.getElementById('nl_plan_row').style.display = e.target.value === 'revolving' ? 'none' : ''; };
  const cancelBtn = document.getElementById('nl_cancel');
  if (cancelBtn) cancelBtn.onclick = closeSheet;
  const delBtn = document.getElementById('nl_del');
  if (delBtn) delBtn.onclick = () => {
    if (!confirm(`Delete "${S.loans[editId].name}"?`)) return;
    S.loanOrder = S.loanOrder.filter((x) => x !== editId); delete S.loans[editId];
    deleteLoanFull(editId); closeSheet(); if (onDone) onDone();
  };
  document.getElementById('nl_save').onclick = () => {
    const name = (document.getElementById('nl_name').value || '').trim();
    if (!name) { alert('Enter a loan name.'); return; }
    const bal = getInt('nl_bal');
    const rate = parseFloat(document.getElementById('nl_rate').value) || 0;
    const type = document.getElementById('nl_type').value;
    const plan = type === 'fixed' ? getInt('nl_plan') : 0;
    const dayRaw = parseInt(document.getElementById('nl_day').value) || 0;
    const payDay = dayRaw >= 1 && dayRaw <= 31 ? dayRaw : null;
    if (editId) {
      const l = S.loans[editId];
      l.name = name; l.bal = bal; if (bal > l.orig) l.orig = bal; l.rate = rate / 100; l.type = type; l.plan = plan; l.payDay = payDay;
      persistLoan(editId);
    } else {
      const id = 'loan_' + Date.now();
      S.loans[id] = { name, bal, orig: bal, rate: rate / 100, type, plan, payDay, color: nextColor(S.loanOrder) };
      S.loanOrder.push(id);
      addLoan(id);
    }
    closeSheet(); if (onDone) onDone();
  };
}

// ── Savings form ──────────────────────────────────────────────────────────────
function openSavingsForm(editId, onDone) {
  const ex = editId ? S.savings[editId] : null;
  scrim.innerHTML = `<div class="sheet">
    <h2>${ex ? 'Edit savings goal' : 'Add savings goal'}</h2>
    <label class="set-label">Goal name</label>
    <input class="set-input" id="sv_name" placeholder="e.g. Emergency fund, Travel, Down payment" value="${ex ? esc(ex.name) : ''}">
    <div class="two">
      <div><label class="set-label">Saved so far</label>
        <input class="set-input mono" id="sv_current" inputmode="numeric" placeholder="0" value="${ex ? Math.round(ex.current).toLocaleString('en-US') : ''}"></div>
      <div><label class="set-label">Target amount</label>
        <input class="set-input mono" id="sv_target" inputmode="numeric" placeholder="0" value="${ex ? Math.round(ex.target).toLocaleString('en-US') : ''}"></div>
    </div>
    <label class="set-label">Monthly contribution</label>
    <input class="set-input mono" id="sv_monthly" inputmode="numeric" placeholder="0" value="${ex ? Math.round(ex.monthly).toLocaleString('en-US') : ''}">
    <div class="btnrow">
      ${editId ? `<button class="ghost" id="sv_del" style="color:var(--danger)">Delete</button>` : `<button class="ghost" id="sv_cancel">Cancel</button>`}
      <button class="primary" id="sv_save">${ex ? 'Save changes' : 'Add goal'}</button>
    </div></div>`;
  scrim.classList.add('open');
  const cancelBtn = document.getElementById('sv_cancel');
  if (cancelBtn) cancelBtn.onclick = closeSheet;
  const delBtn = document.getElementById('sv_del');
  if (delBtn) delBtn.onclick = () => {
    if (!confirm(`Delete "${S.savings[editId].name}"?`)) return;
    S.savingsOrder = S.savingsOrder.filter((x) => x !== editId); delete S.savings[editId];
    deleteSavFull(editId); closeSheet(); if (onDone) onDone();
  };
  document.getElementById('sv_save').onclick = () => {
    const name = (document.getElementById('sv_name').value || '').trim();
    if (!name) { alert('Enter a goal name.'); return; }
    const current = getInt('sv_current'), target = getInt('sv_target'), monthly = getInt('sv_monthly');
    if (editId) {
      const sv = S.savings[editId]; sv.name = name; sv.current = current; sv.target = target; sv.monthly = monthly;
      persistSav(editId);
    } else {
      const id = 'sav_' + Date.now();
      S.savings[id] = { name, current, target, monthly, color: nextColor(S.savingsOrder) };
      S.savingsOrder.push(id);
      addSav(id);
    }
    closeSheet(); if (onDone) onDone();
  };
}

// ── Log loan payments ─────────────────────────────────────────────────────────
function openLogLoans() {
  const plan = plannedLoans(cloneLoans());
  const cur = monthLabel(S.startAbs + S.cursor);
  let h = `<div class="sheet"><h2>Log ${cur}</h2>
    <div class="hint">Enter actual payments made this month.</div>`;
  for (const id of S.loanOrder) {
    const l = S.loans[id]; if (!l || l.bal <= 0.5) continue;
    const planned = Math.round(plan[id] || 0), interest = Math.round(l.bal * l.rate);
    h += `<div class="field" style="--ac:${lc(id)}">
      <div class="flabel">
        <div class="fn"><span class="dot" style="background:${lc(id)}"></span>${esc(l.name)}${l.payDay ? ` <span style="font-size:10px;color:var(--faint)">due ${ord(l.payDay)}</span>` : ''}</div>
        <div class="fmeta mono">bal ${fmt(l.bal)}</div></div>
      <input id="in_${esc(id)}" inputmode="numeric" value="${planned.toLocaleString('en-US')}">
      <div class="quick">
        <span class="chip" data-set="${esc(id)}" data-v="${planned}">Planned ${fmtShort(planned)}</span>
        <span class="chip" data-set="${esc(id)}" data-v="${interest}">Interest only ${fmtShort(interest)}</span>
        <span class="chip" data-set="${esc(id)}" data-v="0">Skip</span></div></div>`;
  }
  for (const id of S.savingsOrder) {
    const sv = S.savings[id]; if (!sv || sv.current >= sv.target) continue;
    h += `<div class="field" style="--ac:${sc(id)}">
      <div class="flabel">
        <div class="fn"><span class="dot" style="background:${sc(id)}"></span>${esc(sv.name)}</div>
        <div class="fmeta mono">${fmt(sv.current)} saved</div></div>
      <input id="in_${esc(id)}" inputmode="numeric" value="${Math.round(sv.monthly).toLocaleString('en-US')}">
      <div class="quick">
        <span class="chip" data-set="${esc(id)}" data-v="${sv.monthly}">Planned ${fmtShort(sv.monthly)}</span>
        <span class="chip" data-set="${esc(id)}" data-v="0">Skip</span></div></div>`;
  }
  h += `<div class="btnrow">
    <button class="ghost" id="cancelLog">Cancel</button>
    <button class="primary" id="saveLog">Save &amp; advance</button>
  </div></div>`;
  scrim.innerHTML = h; scrim.classList.add('open');
  scrim.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { const el = document.getElementById('in_' + c.dataset.set); if (el) el.value = Number(c.dataset.v).toLocaleString('en-US'); }));
  scrim.querySelectorAll('.field input').forEach((inp) => {
    inp.onblur = () => { const n = parseInt(inp.value.replace(/[^\d]/g, '')) || 0; inp.value = n.toLocaleString('en-US'); };
    inp.onfocus = () => { inp.value = inp.value.replace(/[^\d]/g, ''); };
  });
  document.getElementById('cancelLog').onclick = closeSheet;
  document.getElementById('saveLog').onclick = () => {
    const prev = {}, pays = {};
    for (const id of S.loanOrder) {
      const l = S.loans[id]; if (!l) { pays[id] = 0; continue; }
      prev[id] = l.bal; if (l.bal <= 0.5) { pays[id] = 0; continue; }
      const inp = document.getElementById('in_' + id);
      const pay = inp ? (parseInt(inp.value.replace(/[^\d]/g, '')) || 0) : 0;
      pays[id] = pay; l.bal = Math.max(0, l.bal * (1 + l.rate) - pay);
    }
    const savPays = {};
    for (const id of S.savingsOrder) {
      const sv = S.savings[id]; if (!sv || sv.current >= sv.target) continue;
      const inp = document.getElementById('in_' + id);
      const contrib = inp ? (parseInt(inp.value.replace(/[^\d]/g, '')) || 0) : 0;
      savPays[id] = contrib; sv.current = Math.min(sv.target, sv.current + contrib);
    }
    S.history.push({ month: cur, pays, prev, savPays });
    S.cursor++;
    persistMonthChange(); closeSheet(); renderContent();
  };
}

// ── Settings ───────────────────────────────────────────────────────────────
function openSettings() {
  let h = `<div class="sheet"><h2>Settings</h2>`;
  if (currentUser) {
    h += `<div class="user-bar">
      ${currentUser.photoURL ? `<img src="${esc(currentUser.photoURL)}" alt="">` : '<div style="width:36px;height:36px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;color:#fff">👤</div>'}
      <div class="info"><div class="name">${esc(currentUser.displayName || 'Signed in')}</div><div class="email">${esc(currentUser.email)}</div></div>
      <button class="ghost" id="signOutBtn" style="flex:0 0 auto;padding:7px 12px;font-size:12px;border-radius:10px;box-shadow:none">Sign out</button>
    </div>`;
  }
  h += `<label class="set-label">Monthly income</label>
  <input class="set-input mono" id="s_income" inputmode="numeric" placeholder="0" value="${S.income ? S.income.toLocaleString('en-US') : ''}">
  <div style="font-size:11px;color:var(--soft);margin:4px 0 10px">Your take-home pay per month.</div>
  <label class="set-label">Monthly spending budget</label>
  <input class="set-input mono" id="s_budget" inputmode="numeric" placeholder="0" value="${S.budget ? S.budget.toLocaleString('en-US') : ''}">
  <div style="font-size:11px;color:var(--soft);margin:4px 0 2px">How much you aim to spend on everyday living each month (food, transport, fun…). Loan payments and savings are tracked separately. The Overview compares your actual spending against this.</div>
  <div class="divider"></div>
  <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;margin-bottom:4px">Category budgets <span style="font-weight:400;font-size:11px;color:var(--soft)">(optional)</span></div>
  <div style="font-size:11px;color:var(--soft);margin-bottom:10px">Split the budget above into per-category limits. You'll see a ⚠ when you go over one.</div>
  ${CATEGORIES.map((c) => `<div class="catbud-row"><span class="lbl">${c.icon} ${c.label}</span><input class="set-input mono" id="cb_${c.id}" inputmode="numeric" placeholder="—" value="${S.catBudgets[c.id] ? S.catBudgets[c.id].toLocaleString('en-US') : ''}"></div>`).join('')}
  <div class="divider"></div>
  <div class="btnrow">
    <button class="ghost" id="exportBtn">⬇ Export backup</button>
  </div>
  <div class="btnrow">
    <button class="ghost" id="resetBtn" style="color:var(--danger)">Reset all</button>
    <button class="primary" id="saveSet">Save</button>
  </div></div>`;
  scrim.innerHTML = h; scrim.classList.add('open');
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.onclick = doSignOut;
  document.getElementById('exportBtn').onclick = exportData;
  document.getElementById('resetBtn').onclick = () => { if (confirm('Erase everything?')) { resetAll(); closeSheet(); view = 'onboarding'; renderOnboarding(); } };
  const gi = (id) => parseInt((document.getElementById(id).value || '').replace(/[^\d]/g, '')) || 0;
  document.getElementById('saveSet').onclick = () => {
    S.income = gi('s_income'); S.budget = gi('s_budget');
    const cb = {};
    for (const c of CATEGORIES) { const v = gi('cb_' + c.id); if (v > 0) cb[c.id] = v; }
    S.catBudgets = cb;
    persistSettings(); closeSheet(); renderContent(); toast('Settings saved');
  };
}

// ── Auth ───────────────────────────────────────────────────────────────────
function renderLogin() {
  appEl.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:0 24px">
      <div style="font-size:52px;margin-bottom:16px">₮</div>
      <div class="welcome" style="margin-bottom:8px">Fin Plan</div>
      <div style="color:var(--soft);font-size:13px;margin-bottom:32px;line-height:1.6">Track spending, loans and savings.<br>All in one place.</div>
      ${configured ? `
        <button class="primary" id="signInBtn" style="max-width:280px">Sign in with Google</button>
        <div class="footnote" style="margin-top:16px">Data is private and synced to your Google account.</div>
      ` : `
        <div style="background:#FBE9E7;border-radius:12px;padding:14px 16px;font-size:12px;line-height:1.7;color:var(--danger);max-width:320px">
          Firebase not configured. Edit <strong>src/firebase.js</strong>.
        </div>
      `}
    </div>`;
  if (configured) document.getElementById('signInBtn').onclick = signIn;
}

async function signIn() {
  const btn = document.getElementById('signInBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in with Google'; }
    const r = ['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
    if (r.includes(e.code)) { await signInWithRedirect(auth, provider); }
    else alert('Sign-in failed: ' + (e.message || e.code));
  }
}
async function doSignOut() { if (confirm('Sign out?')) await signOut(auth); }

// ── Onboarding ───────────────────────────────────────────────────────────────
function renderOnboarding() {
  let step = 1;
  const STEPS = 4;
  function show() {
    const progress = Array.from({ length: STEPS }, (_, i) => `<div style="height:3px;flex:1;border-radius:3px;background:${i < step ? 'var(--ink)' : 'var(--rule)'}"></div>`).join('');
    let body = '';
    if (step === 1) {
      body = `<div class="welcome" style="margin-bottom:8px">What's your monthly income?</div>
        <div style="color:var(--soft);font-size:13px;margin-bottom:24px">Take-home pay after tax.</div>
        <input class="set-input mono" id="ob_income" inputmode="numeric" placeholder="0" value="${S.income || ''}" style="font-size:22px;padding:14px 16px">
        <div class="btnrow" style="margin-top:20px"><button class="primary" id="ob_next">Continue →</button></div>`;
    } else if (step === 2) {
      body = `<div class="welcome" style="margin-bottom:8px">Monthly spending budget?</div>
        <div style="color:var(--soft);font-size:13px;margin-bottom:24px">How much do you plan to spend on living expenses per month? (Loan payments tracked separately.)</div>
        <input class="set-input mono" id="ob_budget" inputmode="numeric" placeholder="0" value="${S.budget || ''}" style="font-size:22px;padding:14px 16px">
        <div class="btnrow" style="margin-top:20px"><button class="ghost" id="ob_back">← Back</button><button class="primary" id="ob_next">Continue →</button></div>`;
    } else if (step === 3) {
      const rows = S.loanOrder.length === 0 ? `<div class="empty" style="margin:0 0 12px">No loans added yet.</div>` : S.loanOrder.map((id) => { const l = S.loans[id]; return !l ? '' : `<div class="ob-item" style="border-left-color:${l.color}"><div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:14px">${esc(l.name)}</div><div style="font-size:12px;color:var(--soft)">${fmt(l.bal)}</div></div>`; }).join('');
      body = `<div class="welcome" style="margin-bottom:8px">Any loans?</div>
        <div style="color:var(--soft);font-size:13px;margin-bottom:16px">Add loans you're currently paying off.</div>
        ${rows}<button class="ghost" id="ob_addloan" style="width:100%;margin-bottom:20px">＋ Add a loan</button>
        <div class="btnrow"><button class="ghost" id="ob_back">← Back</button><button class="primary" id="ob_next">${S.loanOrder.length ? 'Continue →' : 'Skip →'}</button></div>`;
    } else if (step === 4) {
      const rows = S.savingsOrder.length === 0 ? `<div class="empty" style="margin:0 0 12px">No goals added yet.</div>` : S.savingsOrder.map((id) => { const sv = S.savings[id]; return !sv ? '' : `<div class="ob-item" style="border-left-color:${sv.color}"><div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:14px">${esc(sv.name)}</div><div style="font-size:12px;color:var(--soft)">${fmt(sv.current)} / ${fmt(sv.target)}</div></div>`; }).join('');
      body = `<div class="welcome" style="margin-bottom:8px">Savings goals?</div>
        <div style="color:var(--soft);font-size:13px;margin-bottom:16px">Emergency fund, travel, down payment — track each separately.</div>
        ${rows}<button class="ghost" id="ob_addsav" style="width:100%;margin-bottom:20px">＋ Add a goal</button>
        <div class="btnrow"><button class="ghost" id="ob_back">← Back</button><button class="primary" id="ob_done">Get started →</button></div>`;
    }
    appEl.innerHTML = `<div style="padding:40px 16px 0;max-width:400px;margin:0 auto">
      <div style="display:flex;gap:4px;margin-bottom:32px">${progress}</div>${body}</div>`;
    const nextBtn = document.getElementById('ob_next');
    if (nextBtn) nextBtn.onclick = () => {
      if (step === 1) { S.income = getInt('ob_income'); persistSettings(); step++; show(); }
      else if (step === 2) { S.budget = getInt('ob_budget'); persistSettings(); step++; show(); }
      else { step++; show(); }
    };
    const backBtn = document.getElementById('ob_back');
    if (backBtn) backBtn.onclick = () => { step--; show(); };
    const addLoanBtn = document.getElementById('ob_addloan');
    if (addLoanBtn) addLoanBtn.onclick = () => openLoanForm(null, show);
    const addSavBtn = document.getElementById('ob_addsav');
    if (addSavBtn) addSavBtn.onclick = () => openSavingsForm(null, show);
    const doneBtn = document.getElementById('ob_done');
    if (doneBtn) doneBtn.onclick = () => { S.onboarded = true; persistSettings(); view = 'shell'; renderShell(); };
  }
  show();
}

// ── Undo / Export / Import ─────────────────────────────────────────────────────
function undo() {
  if (!S.history.length) return;
  const last = S.history.pop();
  for (const id in last.prev) { if (S.loans[id]) S.loans[id].bal = last.prev[id]; }
  if (last.savPays) { for (const id in last.savPays) { if (S.savings[id]) S.savings[id].current = Math.max(0, S.savings[id].current - last.savPays[id]); } }
  S.cursor = Math.max(0, S.cursor - 1);
  persistMonthChange(); renderContent();
}
function exportData() {
  try {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'finplan-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) { alert('Export failed.'); }
}

// ── Boot ───────────────────────────────────────────────────────────────────
let booted = false;
function go() {
  if (!currentUser) { view = 'login'; renderLogin(); return; }
  if (!S.onboarded) { view = 'onboarding'; renderOnboarding(); }
  else { view = 'shell'; renderShell(); }
  booted = true;
}

if (!configured) {
  renderLogin();
} else {
  const cachedUid = (() => { try { return localStorage.getItem(UIDKEY); } catch (e) { return null; } })();

  // Optimistic: if this device was signed in before, render instantly from the
  // local cache without waiting for the auth/network round-trip.
  if (cachedUid) {
    const saved = migrate(loadLocal());
    if (saved) S = saved;
    go();
  } else {
    appEl.innerHTML = `<div style="text-align:center;padding:80px 0;color:var(--faint);font-size:13px">Loading…</div>`;
  }

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user) {
      detachListeners();
      closeSheet();
      try { localStorage.removeItem(UIDKEY); } catch (e) {}
      view = 'login'; booted = false; renderLogin();
      return;
    }
    try { localStorage.setItem(UIDKEY, user.uid); } catch (e) {}
    // Different account on this device → drop the previous user's cached data.
    if (cachedUid && cachedUid !== user.uid) {
      try { localStorage.removeItem(KEY); } catch (e) {}
      S = defaults(); booted = false;
    }
    // Render immediately — never block on the network. Real-time listeners fire
    // from the local cache near-instantly and reconcile the view; the one-time
    // legacy migration runs in the background.
    if (!booted) go();
    attachListeners();
    migrateRemoteIfNeeded();
  });
}
