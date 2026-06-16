// App state (the single source of truth `S`) plus all the pure selectors and
// formatting helpers that read it. No DOM, no Firebase — this is the "model"
// layer. `S` is reassigned wholesale on reset/import/boot, so consumers must
// import the live binding (and call setS to replace it).

import * as F from './finance.js';
import { BASE, PALETTE, DEFAULT_CATEGORIES, OTHER_CAT, CURRENCIES, ACCOUNT_TYPE_MAP } from './constants.js';

// ── State ─────────────────────────────────────────────────────────────────────
export function defaults() {
  const now = new Date();
  return {
    onboarded: false,
    income: 0,
    budget: 0,
    loans: {},
    loanOrder: [],
    savings: {},
    savingsOrder: [],
    accounts: {},          // liquid accounts: { id: { name, balance, type, color } }
    accountOrder: [],
    spends: [],
    cursor: 0,
    startAbs: now.getFullYear() * 12 + now.getMonth() - BASE,
    history: [],
    catBudgets: {},        // { categoryId: monthly limit }
    customCategories: [],  // user-added categories: { id, label, icon, color }
    recurring: [],         // recurring spend templates: { id, amount, category, note, day }
    currency: 'MNT',       // display currency code (see CURRENCIES)
  };
}
export let S = defaults();
export function setS(next) { S = next; }

// Normalises any local/imported state object to the current in-memory shape.
export function migrate(s) {
  if (!s) return s;
  if (!s.loanOrder) { s.loanOrder = s.order || []; delete s.order; }
  if (!s.loans) s.loans = {};
  if (!s.savings) s.savings = {};
  if (!s.savingsOrder) s.savingsOrder = [];
  if (!s.accounts) s.accounts = {};
  if (!s.accountOrder) s.accountOrder = [];
  if (!s.spends) s.spends = [];
  if (!s.history) s.history = [];
  if (!s.catBudgets) s.catBudgets = {};
  if (!s.customCategories) s.customCategories = [];
  if (!s.recurring) s.recurring = [];
  if (!s.currency) s.currency = 'MNT';
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
import { KEY } from './constants.js';
export function loadLocal() {
  try { const v = localStorage.getItem(KEY); if (v) return JSON.parse(v); } catch (e) {}
  return null;
}
export function persistLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
}

// ── Currency ──────────────────────────────────────────────────────────────────
export let CUR = CURRENCIES[0];
export const applyCurrency = (code) => { CUR = CURRENCIES.find((c) => c.code === code) || CURRENCIES[0]; };

export const fmt = (n) => CUR.symbol + Math.round(n).toLocaleString('en-US');
export const fmtShort = (n) => {
  n = Math.round(n);
  return n >= 1e6 ? CUR.symbol + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M'
    : n >= 1e3 ? CUR.symbol + (n / 1e3).toFixed(0) + 'k'
    : CUR.symbol + n.toLocaleString('en-US');
};

// ── Categories ──────────────────────────────────────────────────────────────────
// Categories shown to the user = the 8 built-ins plus any custom ones the user
// added (stored in S.customCategories, synced like the rest of settings).
export const allCats = () => DEFAULT_CATEGORIES.concat(S.customCategories || []);
export const catMap = () => Object.fromEntries(allCats().map((c) => [c.id, c]));
// Resolve a category id to its definition; unknown/deleted ids (e.g. a spend
// whose custom category was later removed) fall back to "Other" so nothing
// renders blank.
export const catOf = (id) => catMap()[id] || OTHER_CAT;
export const nextColor = (order) => PALETTE[order.length % PALETTE.length];

// ── Date / month helpers ──────────────────────────────────────────────────────
export const monthLabel = (abs) => { const t = BASE + abs; return `${Math.floor(t / 12)}.${String((t % 12) + 1).padStart(2, '0')}`; };
// Current real calendar month as an absolute index (same basis as startAbs).
export const nowAbs = () => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() - BASE; };
// The month the user is currently logging loans for; capped so the loan timeline
// never runs ahead of the real calendar (keeps it aligned with the Spending tab).
export const loanMonthAbs = () => S.startAbs + S.cursor;
export const caughtUpOnLoans = () => loanMonthAbs() > nowAbs();
export const lc = (id) => (S.loans[id] && S.loans[id].color) || '#566072';
export const sc = (id) => (S.savings[id] && S.savings[id].color) || '#0369A1';
export const ac = (id) => (S.accounts[id] && S.accounts[id].color) || '#147A5C';
export const acctIcon = (type) => (ACCOUNT_TYPE_MAP[type] || ACCOUNT_TYPE_MAP.bank).icon;
export const ord = (d) => d + (d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th');
export const getInt = (id) => parseInt((document.getElementById(id).value || '').replace(/[^\d]/g, '')) || 0;
export const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

export function nowMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthDisplay(ym) {
  const [y, m] = ym.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m) - 1]} ${y}`;
}
export function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function nextMonthStr(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const dateStrFromTs = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ── Finance (pure engine lives in finance.js; these bind it to live state) ────
export const cloneLoans = () => F.cloneLoans(S);
export const plannedLoans = (L) => F.plannedLoans(S, L);
export const totalSavingsContrib = () => F.totalSavingsContrib(S);
export const freeCash = () => F.freeCash(S);
export const simulateLoans = () => F.simulateLoans(S);
export const savMonthsToGoal = (id) => F.savMonthsToGoal(S, id);

// Totals across the entity collections. Net worth = liquid accounts + money set
// aside in savings goals − outstanding loan balances.
export const totalAccounts = () => S.accountOrder.reduce((s, id) => s + (S.accounts[id] ? S.accounts[id].balance : 0), 0);
export const totalSaved = () => S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].current : 0), 0);
export const totalDebt = () => S.loanOrder.reduce((s, id) => s + (S.loans[id] ? S.loans[id].bal : 0), 0);
export const netWorth = () => totalAccounts() + totalSaved() - totalDebt();

// ── Spending helpers ──────────────────────────────────────────────────────────
export function spendsForMonth(ym) { return S.spends.filter((sp) => sp.month === ym); }
export function totalForMonth(ym) { return spendsForMonth(ym).reduce((s, sp) => s + sp.amount, 0); }
export function byCategory(ym) {
  const totals = {};
  for (const sp of spendsForMonth(ym)) totals[sp.category] = (totals[sp.category] || 0) + sp.amount;
  return totals;
}
// Last `n` months (oldest→newest) with their spend totals, for the trend chart.
export function lastMonthsTotals(n) {
  const arr = [];
  let ym = nowMonth();
  for (let i = 0; i < n; i++) { arr.unshift({ ym, total: totalForMonth(ym) }); ym = prevMonth(ym); }
  return arr;
}

// Recurring templates not yet added to the given month.
export function pendingRecurring(ym) {
  return (S.recurring || []).filter((r) => !S.spends.some((sp) => sp.month === ym && sp.rec === r.id));
}
