// Persistence layer: Firestore reads/writes, the local-first sync bookkeeping,
// and the real-time listeners. Knows nothing about the DOM — it talks to the UI
// only through two injected callbacks (setReconcile / setSyncDot), so this
// module never imports the view layer (keeps the dependency graph acyclic).

import { db } from './firebase.js';
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
import { S, setS, defaults, migrate, persistLocal, applyCurrency } from './state.js';
import { SCHEMA } from './constants.js';

// ── Session ───────────────────────────────────────────────────────────────────
export let currentUser = null;
export function setCurrentUser(u) { currentUser = u; }
export let syncState = 'idle';

// UI callbacks, wired once at boot (main.js). Default to no-ops so this module
// works headless (e.g. in tests).
let reconcileFn = () => {};
let syncDotFn = () => {};
export function setReconcile(fn) { reconcileFn = fn; }
export function setSyncDot(fn) { syncDotFn = fn; }

// ── Firestore references ──────────────────────────────────────────────────────
export const userDoc  = () => doc(db, 'users', currentUser.uid);
export const loanDoc  = (id) => doc(db, 'users', currentUser.uid, 'loans', id);
export const savDoc   = (id) => doc(db, 'users', currentUser.uid, 'savings', id);
export const accDoc   = (id) => doc(db, 'users', currentUser.uid, 'accounts', id);
export const spendDoc = (id) => doc(db, 'users', currentUser.uid, 'spends', id);
const loansCol  = () => collection(db, 'users', currentUser.uid, 'loans');
const savCol    = () => collection(db, 'users', currentUser.uid, 'savings');
const accCol    = () => collection(db, 'users', currentUser.uid, 'accounts');
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
    accountOrder: S.accountOrder,
    history: S.history,
    catBudgets: S.catBudgets,
    customCategories: S.customCategories,
    recurring: S.recurring,
    currency: S.currency,
    schema: SCHEMA,
    updatedAt: serverTimestamp(),
  };
}

export async function trackSync(p) {
  syncState = 'syncing'; syncDotFn();
  try { await p; syncState = 'idle'; }
  catch (e) { syncState = 'error'; console.error('[fin-plan] Firestore write failed:', e); }
  syncDotFn();
}

export const canWrite = () => !!(db && currentUser);

// Per-entity writes. Local cache is updated synchronously; Firestore in the
// background. Concurrent edits to different entities never clobber each other.
export function persistSettings() {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(userDoc(), settingsPayload(), { merge: true }));
}
export function persistLoan(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(loanDoc(id), S.loans[id]));
}
export function persistSav(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(savDoc(id), S.savings[id]));
}
export function persistSpend(id) {
  persistLocal();
  if (!canWrite()) return;
  const rec = S.spends.find((x) => x.id === id);
  if (!rec) return;
  const { id: _omit, ...data } = rec;
  trackSync(setDoc(spendDoc(id), data));
}
export function persistSpendDelete(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(deleteDoc(spendDoc(id)));
}
export function addLoan(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.set(loanDoc(id), S.loans[id]);
  b.set(userDoc(), { loanOrder: S.loanOrder, schema: SCHEMA, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
export function deleteLoanFull(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.delete(loanDoc(id));
  b.set(userDoc(), { loanOrder: S.loanOrder, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
export function addSav(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.set(savDoc(id), S.savings[id]);
  b.set(userDoc(), { savingsOrder: S.savingsOrder, schema: SCHEMA, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
export function deleteSavFull(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.delete(savDoc(id));
  b.set(userDoc(), { savingsOrder: S.savingsOrder, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
export function persistAcc(id) {
  persistLocal();
  if (!canWrite()) return;
  trackSync(setDoc(accDoc(id), S.accounts[id]));
}
export function addAcc(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.set(accDoc(id), S.accounts[id]);
  b.set(userDoc(), { accountOrder: S.accountOrder, schema: SCHEMA, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
export function deleteAccFull(id) {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  b.delete(accDoc(id));
  b.set(userDoc(), { accountOrder: S.accountOrder, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
// Month log / undo: balances + goal totals + history + cursor change together.
export function persistMonthChange() {
  persistLocal();
  if (!canWrite()) return;
  const b = writeBatch(db);
  for (const id of S.loanOrder) if (S.loans[id]) b.set(loanDoc(id), S.loans[id]);
  for (const id of S.savingsOrder) if (S.savings[id]) b.set(savDoc(id), S.savings[id]);
  b.set(userDoc(), { history: S.history, cursor: S.cursor, updatedAt: serverTimestamp() }, { merge: true });
  trackSync(b.commit());
}
// Firestore batches cap at 500 writes; chunk for reset/import.
export async function runChunked(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = writeBatch(db);
    for (const fn of ops.slice(i, i + 450)) fn(b);
    await b.commit();
  }
}
export function resetAll() {
  const loanIds = Object.keys(S.loans);
  const savIds = Object.keys(S.savings);
  const accIds = Object.keys(S.accounts);
  const spendIds = S.spends.map((s) => s.id);
  setS(defaults());
  persistLocal();
  if (!canWrite()) return;
  const ops = [];
  loanIds.forEach((id) => ops.push((b) => b.delete(loanDoc(id))));
  savIds.forEach((id) => ops.push((b) => b.delete(savDoc(id))));
  accIds.forEach((id) => ops.push((b) => b.delete(accDoc(id))));
  spendIds.forEach((id) => ops.push((b) => b.delete(spendDoc(id))));
  ops.push((b) => b.set(userDoc(), settingsPayload()));
  trackSync(runChunked(ops));
}
// Writes every in-memory entity to Firestore (used to seed an empty cloud and
// for the legacy-blob upgrade). Does NOT delete anything.
export function uploadOps(src) {
  const ops = [];
  for (const id of Object.keys(src.loans || {})) ops.push((b) => b.set(loanDoc(id), src.loans[id]));
  for (const id of Object.keys(src.savings || {})) ops.push((b) => b.set(savDoc(id), src.savings[id]));
  for (const id of Object.keys(src.accounts || {})) ops.push((b) => b.set(accDoc(id), src.accounts[id]));
  for (const sp of src.spends || []) { const { id: _o, ...rest } = sp; ops.push((b) => b.set(spendDoc(sp.id), rest)); }
  ops.push((b) => b.set(userDoc(), {
    income: src.income || 0,
    budget: src.budget || 0,
    onboarded: !!src.onboarded,
    cursor: src.cursor || 0,
    startAbs: src.startAbs,
    loanOrder: src.loanOrder || [],
    savingsOrder: src.savingsOrder || [],
    accountOrder: src.accountOrder || [],
    history: src.history || [],
    catBudgets: src.catBudgets || {},
    customCategories: src.customCategories || [],
    recurring: src.recurring || [],
    currency: src.currency || 'MNT',
    schema: SCHEMA,
    payload: deleteField(),
    updatedAt: serverTimestamp(),
  }, { merge: true }));
  return ops;
}

// Run once after sign-in, BEFORE attaching listeners:
//  - legacy single-blob doc { payload } → per-entity docs
//  - cloud has no doc yet (e.g. database just created) but this device has local
//    data → push it up, so the empty-collection snapshots don't wipe it
export async function prepareRemote() {
  if (!canWrite()) return;
  let snap;
  try { snap = await getDoc(userDoc()); }
  catch (e) { console.error('[fin-plan] Firestore read failed (is the database created?):', e); return; }
  const d = snap.exists() ? snap.data() : null;

  if (d && d.payload && d.schema !== SCHEMA) {
    const parsed = migrate(JSON.parse(d.payload));
    try { await runChunked(uploadOps(parsed)); setS(parsed); persistLocal(); reconcileFn(); }
    catch (e) { console.error('[fin-plan] legacy migration failed:', e); }
    return;
  }

  if (!d) {
    const hasLocal = S.onboarded || S.loanOrder.length || S.savingsOrder.length || S.spends.length || S.income || S.budget;
    if (!hasLocal) return;
    try { await runChunked(uploadOps(S)); persistLocal(); }
    catch (e) { console.error('[fin-plan] initial cloud seed failed:', e); }
  }
}

// ── Real-time listeners ───────────────────────────────────────────────────────
let unsubs = [];
export function detachListeners() { unsubs.forEach((u) => u()); unsubs = []; }
export function attachListeners() {
  detachListeners();
  unsubs.push(onSnapshot(userDoc(), (snap) => {
    const d = snap.data();
    if (!d) return;
    // Legacy single-blob doc — ignore until prepareRemote() converts it,
    // otherwise we'd wipe the view to empty before the real fields are written.
    if (d.payload && d.schema !== SCHEMA) return;
    S.income = d.income || 0;
    S.budget = d.budget || 0;
    S.onboarded = !!d.onboarded;
    S.cursor = d.cursor || 0;
    if (typeof d.startAbs === 'number') S.startAbs = d.startAbs;
    S.loanOrder = d.loanOrder || [];
    S.savingsOrder = d.savingsOrder || [];
    S.accountOrder = d.accountOrder || [];
    S.history = d.history || [];
    S.catBudgets = d.catBudgets || {};
    S.customCategories = d.customCategories || [];
    S.recurring = d.recurring || [];
    S.currency = d.currency || 'MNT';
    applyCurrency(S.currency);
    reconcileFn();
  }, () => {}));
  unsubs.push(onSnapshot(loansCol(), (snap) => {
    const m = {}; snap.forEach((dc) => { m[dc.id] = dc.data(); }); S.loans = m; reconcileFn();
  }, () => {}));
  unsubs.push(onSnapshot(savCol(), (snap) => {
    const m = {}; snap.forEach((dc) => { m[dc.id] = dc.data(); }); S.savings = m; reconcileFn();
  }, () => {}));
  unsubs.push(onSnapshot(accCol(), (snap) => {
    const m = {}; snap.forEach((dc) => { m[dc.id] = dc.data(); }); S.accounts = m; reconcileFn();
  }, () => {}));
  unsubs.push(onSnapshot(spendsCol(), (snap) => {
    const a = []; snap.forEach((dc) => a.push({ id: dc.id, ...dc.data() })); S.spends = a; reconcileFn();
  }, () => {}));
}
