// The interactive layer: every bottom-sheet form/detail, the settings sheet,
// the categories & recurring managers, onboarding, the login screen, and the
// import/export/undo actions. Calls back into views.js (renderContent /
// renderShell) to refresh the underlying screen — the cycle resolves at runtime.

import { esc, CURRENCIES, APP_VERSION, PALETTE, ACCOUNT_TYPES, ACCOUNT_TYPE_MAP } from './constants.js';
import {
  S, setS, fmt, fmtShort, allCats, catOf, CUR, todayStr, dateStrFromTs, ord, lc, sc, ac, acctIcon,
  monthLabel, nowAbs, simulateLoans, plannedLoans, cloneLoans,
  getInt, nextColor, savMonthsToGoal, totalAccounts, migrate, persistLocal, applyCurrency,
} from './state.js';
import {
  persistSpend, persistSpendDelete, persistLoan, persistSav, addLoan, addSav,
  deleteLoanFull, deleteSavFull, persistAcc, addAcc, deleteAccFull,
  persistSettings, resetAll,
  uploadOps, loanDoc, savDoc, spendDoc, canWrite, runChunked, trackSync,
  currentUser, syncState,
} from './store.js';
import { scrim, appEl, V, closeSheet, toast, confirmDialog, alertDialog, getTheme, applyTheme } from './dom.js';
import { renderContent, renderShell } from './views.js';
import { auth, provider, configured } from './firebase.js';
import { signInWithPopup, signInWithRedirect, signOut } from 'firebase/auth';

// ── Add spending sheet ─────────────────────────────────────────────────────────
export function openAddSpend(prefill) {
  let selCat = (prefill && prefill.category) || V.lastCat;
  const catGrid = () => allCats().map((c) => `
    <div class="cat-pick${selCat === c.id ? ' selected' : ''}" data-cat="${esc(c.id)}">
      <span class="icon">${esc(c.icon)}</span>
      <span class="label">${esc(c.label)}</span>
    </div>`).join('');

  scrim.innerHTML = `<div class="sheet">
    <h2>Add spending</h2>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
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
    if (!amount) { toast('Enter an amount.'); return; }
    const note = (document.getElementById('sp_note').value || '').trim();
    const dateStr = document.getElementById('sp_date').value || todayStr();
    const ts = dateStr === todayStr() ? Date.now() : new Date(dateStr + 'T12:00:00').getTime();
    const ym = dateStr.slice(0, 7);
    const id = 'sp_' + Date.now();
    V.lastCat = selCat;
    S.spends.push({ id, ts, month: ym, amount, category: selCat, note });
    persistSpend(id); closeSheet(); renderContent();
    toast(`Added ${fmt(amount)} · ${catOf(selCat).label}`);
  };
}

export function openEditSpend(id) {
  const sp = S.spends.find((x) => x.id === id); if (!sp) return;
  let selCat = sp.category;
  const catGrid = () => allCats().map((c) => `
    <div class="cat-pick${selCat === c.id ? ' selected' : ''}" data-cat="${esc(c.id)}">
      <span class="icon">${esc(c.icon)}</span>
      <span class="label">${esc(c.label)}</span>
    </div>`).join('');

  scrim.innerHTML = `<div class="sheet">
    <h2>Edit spending</h2>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
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
  document.getElementById('sp_del').onclick = async () => {
    if (!(await confirmDialog('Delete this entry?', { okText: 'Delete', danger: true }))) return;
    S.spends = S.spends.filter((x) => x.id !== id);
    persistSpendDelete(id); closeSheet(); renderContent();
    toast('Entry deleted');
  };
  document.getElementById('sp_save').onclick = () => {
    const amount = parseInt((document.getElementById('sp_amount').value || '').replace(/[^\d]/g, '')) || 0;
    if (!amount) { toast('Enter an amount.'); return; }
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

export function openLoanDetail(id) {
  const l = S.loans[id]; if (!l) return;
  const log = l.paidLog || [];
  const done = l.bal <= 0.5;
  // Actual balance trajectory: original → each logged payment's after-balance →
  // current. No global month cursor; built straight from this loan's own log.
  const actual = [];
  if (l.orig != null && l.orig !== l.bal) actual.push({ abs: (log[0] ? log[0].abs : nowAbs()) - 1, bal: l.orig });
  for (const e of log) actual.push({ abs: e.abs, bal: e.bal });
  if (!actual.length || actual[actual.length - 1].bal !== l.bal) actual.push({ abs: nowAbs(), bal: l.bal });
  const sim = simulateLoans();
  const projected = sim.snaps.map((sn) => ({ abs: sn.abs, bal: sn.bals[id] || 0 }));
  // Stats combine any pre-migration combined-log history with new per-loan logs.
  let intPaid = 0, paysMade = 0;
  for (let k = 0; k < (S.cursor || 0); k++) { const hi = S.history[k]; if (!hi) continue; intPaid += ((hi.prev && hi.prev[id]) || 0) * l.rate; if (hi.pays && hi.pays[id] > 0) paysMade++; }
  for (const e of log) { intPaid += (e.prevBal || 0) * l.rate; if (e.paid > 0) paysMade++; }
  const pct = l.orig > 0 ? Math.round((1 - l.bal / l.orig) * 100) : 0;
  const hit = projected.find((p) => p.bal <= 0.5);
  const gone = done ? 'Paid off' : hit ? monthLabel(hit.abs) : '—';
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
    ${done ? '' : `<button class="primary" id="logPay" style="width:100%;margin-bottom:10px">＋ Log a payment</button>`}
    ${log.length ? `<button class="ghost" id="undoPay" style="width:100%;margin-bottom:10px;color:var(--danger)">↩ Undo last payment</button>` : ''}
    <div class="btnrow">
      <button class="ghost" id="editLoan">Edit</button>
      <button class="primary" id="closeDet">Close</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('closeDet').onclick = closeSheet;
  document.getElementById('editLoan').onclick = () => { closeSheet(); openLoanForm(id, renderContent); };
  const logPay = document.getElementById('logPay');
  if (logPay) logPay.onclick = () => openLoanLog(id);
  const undoPay = document.getElementById('undoPay');
  if (undoPay) undoPay.onclick = async () => {
    if (!(await confirmDialog('Undo the most recent logged payment for this loan?', { okText: 'Undo' }))) return;
    const last = l.paidLog.pop();
    if (last) l.bal = last.prevBal;
    persistLoan(id); renderContent(); openLoanDetail(id);
  };
}

// Per-loan payment logging: applies one month's interest + the entered payment,
// records it in the loan's own history, and re-opens the detail to show it.
function openLoanLog(id) {
  const l = S.loans[id]; if (!l || l.bal <= 0.5) return;
  const planned = Math.round(plannedLoans(cloneLoans())[id] || 0);
  const interest = Math.round(l.bal * l.rate);
  scrim.innerHTML = `<div class="sheet">
    <h2>Log payment</h2>
    <div class="hint"><span class="dot" style="background:${lc(id)};display:inline-block;width:9px;height:9px;border-radius:50%"></span> ${esc(l.name)} · balance ${fmt(l.bal)}</div>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="lp_amount" inputmode="numeric" value="${planned.toLocaleString('en-US')}">
    <div class="quick" style="justify-content:center">
      <span class="chip" data-v="${planned}">Planned ${fmtShort(planned)}</span>
      <span class="chip" data-v="${interest}">Interest only ${fmtShort(interest)}</span>
    </div>
    <div class="btnrow">
      <button class="ghost" id="lp_cancel">Cancel</button>
      <button class="primary" id="lp_save">Log payment</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('lp_amount').focus();
  scrim.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { document.getElementById('lp_amount').value = Number(c.dataset.v).toLocaleString('en-US'); }));
  document.getElementById('lp_cancel').onclick = () => openLoanDetail(id);
  document.getElementById('lp_save').onclick = () => {
    const paid = parseInt((document.getElementById('lp_amount').value || '').replace(/[^\d]/g, '')) || 0;
    const prevBal = l.bal;
    const bal = Math.max(0, l.bal * (1 + l.rate) - paid);
    l.paidLog = l.paidLog || [];
    l.paidLog.push({ abs: nowAbs(), paid, prevBal, bal });
    l.bal = bal;
    persistLoan(id); renderContent();
    toast(`Logged ${fmt(paid)} · ${l.name}`);
    openLoanDetail(id);
  };
}

// ── Savings detail ──────────────────────────────────────────────────────────
export function openSavDetail(id) {
  const sv = S.savings[id]; if (!sv) return;
  const done = sv.current >= sv.target;
  const prog = sv.target > 0 ? Math.min(100, (sv.current / sv.target) * 100) : 0;
  const months = savMonthsToGoal(id);
  const color = sc(id);
  const hasLog = (sv.contribLog || []).length > 0;
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
      <div><div class="k">Reach by</div><div class="v mono">${done ? '✓ Done' : months !== null ? monthLabel(nowAbs() + months) : '—'}</div></div>
    </div>
    ${done ? '' : `<button class="primary" id="logContrib" style="width:100%;margin-bottom:10px">＋ Log a contribution</button>`}
    ${hasLog ? `<button class="ghost" id="undoContrib" style="width:100%;margin-bottom:10px;color:var(--danger)">↩ Undo last contribution</button>` : ''}
    <div class="btnrow">
      <button class="ghost" id="editSav">Edit</button>
      <button class="primary" id="closeSav">Close</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('closeSav').onclick = closeSheet;
  document.getElementById('editSav').onclick = () => { closeSheet(); openSavingsForm(id, renderContent); };
  const logC = document.getElementById('logContrib');
  if (logC) logC.onclick = () => openSavLog(id);
  const undoC = document.getElementById('undoContrib');
  if (undoC) undoC.onclick = async () => {
    if (!(await confirmDialog('Undo the most recent logged contribution?', { okText: 'Undo' }))) return;
    const last = sv.contribLog.pop();
    if (last) sv.current = Math.max(0, sv.current - last.amount);
    persistSav(id); renderContent(); openSavDetail(id);
  };
}

// Per-goal contribution logging: adds to the saved amount (capped at target) and
// records it on the goal's own log, then re-opens the detail.
function openSavLog(id) {
  const sv = S.savings[id]; if (!sv || sv.current >= sv.target) return;
  const planned = Math.round(sv.monthly || 0);
  scrim.innerHTML = `<div class="sheet">
    <h2>Log contribution</h2>
    <div class="hint"><span class="dot" style="background:${sc(id)};display:inline-block;width:9px;height:9px;border-radius:50%"></span> ${esc(sv.name)} · ${fmt(sv.current)} of ${fmt(sv.target)}</div>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="cn_amount" inputmode="numeric" value="${planned ? planned.toLocaleString('en-US') : ''}" placeholder="0">
    ${planned ? `<div class="quick" style="justify-content:center"><span class="chip" data-v="${planned}">Planned ${fmtShort(planned)}</span></div>` : ''}
    <div class="btnrow">
      <button class="ghost" id="cn_cancel">Cancel</button>
      <button class="primary" id="cn_save">Log contribution</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('cn_amount').focus();
  scrim.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { document.getElementById('cn_amount').value = Number(c.dataset.v).toLocaleString('en-US'); }));
  document.getElementById('cn_cancel').onclick = () => openSavDetail(id);
  document.getElementById('cn_save').onclick = () => {
    const amount = parseInt((document.getElementById('cn_amount').value || '').replace(/[^\d]/g, '')) || 0;
    if (!amount) { toast('Enter an amount.'); return; }
    const prev = sv.current;
    sv.current = Math.min(sv.target, sv.current + amount);
    sv.contribLog = sv.contribLog || [];
    sv.contribLog.push({ abs: nowAbs(), amount: sv.current - prev, prev });
    persistSav(id); renderContent();
    toast(`Logged ${fmt(sv.current - prev)} · ${sv.name}`);
    openSavDetail(id);
  };
}

// ── Loan form ───────────────────────────────────────────────────────────────
export function openLoanForm(editId, onDone) {
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
  if (delBtn) delBtn.onclick = async () => {
    if (!(await confirmDialog(`Delete "${S.loans[editId].name}"?`, { okText: 'Delete', danger: true }))) return;
    S.loanOrder = S.loanOrder.filter((x) => x !== editId); delete S.loans[editId];
    deleteLoanFull(editId); closeSheet(); if (onDone) onDone();
  };
  document.getElementById('nl_save').onclick = () => {
    const name = (document.getElementById('nl_name').value || '').trim();
    if (!name) { toast('Enter a loan name.'); return; }
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
      S.loans[id] = { name, bal, orig: bal, rate: rate / 100, type, plan, payDay, color: nextColor(S.loanOrder), paidLog: [] };
      S.loanOrder.push(id);
      addLoan(id);
    }
    closeSheet(); if (onDone) onDone();
  };
}

// ── Savings form ──────────────────────────────────────────────────────────────
export function openSavingsForm(editId, onDone) {
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
  if (delBtn) delBtn.onclick = async () => {
    if (!(await confirmDialog(`Delete "${S.savings[editId].name}"?`, { okText: 'Delete', danger: true }))) return;
    S.savingsOrder = S.savingsOrder.filter((x) => x !== editId); delete S.savings[editId];
    deleteSavFull(editId); closeSheet(); if (onDone) onDone();
  };
  document.getElementById('sv_save').onclick = () => {
    const name = (document.getElementById('sv_name').value || '').trim();
    if (!name) { toast('Enter a goal name.'); return; }
    const current = getInt('sv_current'), target = getInt('sv_target'), monthly = getInt('sv_monthly');
    if (editId) {
      const sv = S.savings[editId]; sv.name = name; sv.current = current; sv.target = target; sv.monthly = monthly;
      persistSav(editId);
    } else {
      const id = 'sav_' + Date.now();
      S.savings[id] = { name, current, target, monthly, color: nextColor(S.savingsOrder), contribLog: [] };
      S.savingsOrder.push(id);
      addSav(id);
    }
    closeSheet(); if (onDone) onDone();
  };
}

// ── Recurring transactions manager ─────────────────────────────────────────────
export function openRecurring() {
  const list = (S.recurring || []).map((r) => {
    const c = catOf(r.category);
    return `<div class="spend-item" data-rec="${esc(r.id)}">
      <div class="cat-icon" style="background:${c.color}22">${esc(c.icon)}</div>
      <div class="info"><div class="name">${r.note ? esc(r.note) : esc(c.label)}</div>
        <div class="meta">${esc(c.label)} · day ${Math.min(31, Math.max(1, r.day || 1))}</div></div>
      <div class="amt">${fmt(r.amount)}</div>
    </div>`;
  }).join('');
  scrim.innerHTML = `<div class="sheet">
    <h2>Recurring</h2>
    <div class="hint">Bills, rent and subscriptions you have every month. Add them once, then tap “Add all” on the Overview or Spending tab each month.</div>
    ${list || '<div class="empty" style="padding:14px 0">No recurring entries yet.</div>'}
    <button class="ghost" id="rec_add" style="width:100%;margin-top:6px">＋ Add recurring entry</button>
    <div class="btnrow"><button class="primary" id="rec_close">Done</button></div>
  </div>`;
  scrim.classList.add('open');
  document.getElementById('rec_close').onclick = openSettings;
  document.getElementById('rec_add').onclick = () => openRecurringForm(null);
  scrim.querySelectorAll('[data-rec]').forEach((el) => (el.onclick = () => openRecurringForm(el.dataset.rec)));
}

function openRecurringForm(editId) {
  const ex = editId ? (S.recurring || []).find((r) => r.id === editId) : null;
  let selCat = ex ? ex.category : V.lastCat;
  const grid = () => allCats().map((c) => `
    <div class="cat-pick${selCat === c.id ? ' selected' : ''}" data-cat="${esc(c.id)}">
      <span class="icon">${esc(c.icon)}</span><span class="label">${esc(c.label)}</span>
    </div>`).join('');
  scrim.innerHTML = `<div class="sheet">
    <h2>${ex ? 'Edit recurring' : 'Add recurring'}</h2>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="rc_amount" inputmode="numeric" placeholder="0" value="${ex ? ex.amount : ''}">
    <div class="cat-grid">${grid()}</div>
    <label class="set-label">Label (optional)</label>
    <input class="set-input" id="rc_note" placeholder="e.g. Rent, Netflix…" value="${ex ? esc(ex.note || '') : ''}">
    <label class="set-label">Day of month (1–31)</label>
    <input class="set-input mono" id="rc_day" inputmode="numeric" maxlength="2" placeholder="1" style="width:120px" value="${ex ? Math.min(31, Math.max(1, ex.day || 1)) : 1}">
    <div class="btnrow">
      ${editId ? '<button class="ghost" id="rc_del" style="color:var(--danger)">Delete</button>' : '<button class="ghost" id="rc_cancel">Cancel</button>'}
      <button class="primary" id="rc_save">${ex ? 'Save' : 'Add'}</button>
    </div></div>`;
  scrim.classList.add('open');
  scrim.querySelectorAll('.cat-pick').forEach((b) => (b.onclick = () => { selCat = b.dataset.cat; scrim.querySelectorAll('.cat-pick').forEach((x) => x.classList.toggle('selected', x.dataset.cat === selCat)); }));
  const cancel = document.getElementById('rc_cancel'); if (cancel) cancel.onclick = openRecurring;
  const del = document.getElementById('rc_del');
  if (del) del.onclick = () => { S.recurring = (S.recurring || []).filter((r) => r.id !== editId); persistSettings(); openRecurring(); };
  document.getElementById('rc_save').onclick = () => {
    const amount = parseInt((document.getElementById('rc_amount').value || '').replace(/[^\d]/g, '')) || 0;
    if (!amount) { toast('Enter an amount.'); return; }
    const note = (document.getElementById('rc_note').value || '').trim();
    const day = Math.min(31, Math.max(1, parseInt(document.getElementById('rc_day').value) || 1));
    if (ex) { ex.amount = amount; ex.category = selCat; ex.note = note; ex.day = day; }
    else { S.recurring = S.recurring || []; S.recurring.push({ id: 'rec_' + Date.now(), amount, category: selCat, note, day }); }
    persistSettings(); openRecurring();
  };
}

// ── Categories manager (custom categories + per-category budgets) ──────────────
export function openCategories() {
  const rows = allCats().map((c) => {
    const custom = (S.customCategories || []).some((x) => x.id === c.id);
    const bud = S.catBudgets[c.id] || '';
    return `<div class="catbud-row">
      <span class="lbl">${esc(c.icon)} ${esc(c.label)}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <input class="set-input mono" data-bud="${esc(c.id)}" inputmode="numeric" placeholder="no limit" value="${bud ? Math.round(bud).toLocaleString('en-US') : ''}">
        ${custom ? `<button class="iconbtn cat-del" data-del="${esc(c.id)}" aria-label="Delete category" style="width:30px;height:30px;font-size:16px;color:var(--danger)">×</button>` : ''}
      </span>
    </div>`;
  }).join('');
  scrim.innerHTML = `<div class="sheet">
    <h2>Categories</h2>
    <div class="hint">Set an optional monthly budget per category (shown on the Spending tab). Add your own categories below.</div>
    ${rows}
    <div class="divider"></div>
    <label class="set-label">New category name</label>
    <input class="set-input" id="cc_name" placeholder="e.g. Pets, Kids, Subscriptions">
    <div class="two" style="margin-top:9px">
      <div><label class="set-label">Emoji / icon</label>
        <input class="set-input" id="cc_icon" placeholder="🏷" maxlength="2"></div>
      <div><label class="set-label">Color</label>
        <div class="color-row" id="cc_colors">${PALETTE.map((p, i) => `<button class="swatch${i === 0 ? ' sel' : ''}" data-color="${p}" style="background:${p}" aria-label="Pick color ${i + 1}"></button>`).join('')}</div></div>
    </div>
    <button class="ghost" id="cc_add" style="width:100%;margin-top:12px">＋ Add category</button>
    <div class="btnrow"><button class="primary" id="cc_done">Done</button></div>
  </div>`;
  scrim.classList.add('open');
  let selColor = PALETTE[0];
  scrim.querySelectorAll('#cc_colors .swatch').forEach((b) => (b.onclick = () => { selColor = b.dataset.color; scrim.querySelectorAll('#cc_colors .swatch').forEach((x) => x.classList.toggle('sel', x === b)); }));
  // Read every budget input into state (called before any re-render so edits stick).
  const saveBudgets = () => {
    scrim.querySelectorAll('[data-bud]').forEach((inp) => {
      const id = inp.getAttribute('data-bud');
      const v = parseInt((inp.value || '').replace(/[^\d]/g, '')) || 0;
      if (v > 0) S.catBudgets[id] = v; else delete S.catBudgets[id];
    });
  };
  scrim.querySelectorAll('.cat-del').forEach((b) => (b.onclick = async () => {
    const id = b.getAttribute('data-del');
    const c = catOf(id);
    if (!(await confirmDialog(`Delete the “${c.label}” category? Existing entries keep their amounts but show as “Other”.`, { okText: 'Delete', danger: true }))) return;
    saveBudgets();
    S.customCategories = (S.customCategories || []).filter((x) => x.id !== id);
    delete S.catBudgets[id];
    persistSettings(); openCategories();
  }));
  document.getElementById('cc_add').onclick = () => {
    const name = (document.getElementById('cc_name').value || '').trim();
    if (!name) { toast('Enter a category name.'); return; }
    const icon = (document.getElementById('cc_icon').value || '').trim() || '🏷';
    saveBudgets();
    S.customCategories = S.customCategories || [];
    S.customCategories.push({ id: 'cat_' + Date.now(), label: name, icon, color: selColor });
    persistSettings(); openCategories();
  };
  document.getElementById('cc_done').onclick = () => { saveBudgets(); persistSettings(); openSettings(); };
}

// ── Accounts manager (liquid money) ─────────────────────────────────────────────
export function openAccounts() {
  const list = S.accountOrder.map((id) => {
    const a = S.accounts[id]; if (!a) return '';
    const t = ACCOUNT_TYPE_MAP[a.type] || ACCOUNT_TYPE_MAP.bank;
    return `<div class="spend-item" data-acc="${esc(id)}">
      <div class="cat-icon" style="background:${ac(id)}22">${esc(acctIcon(a.type))}</div>
      <div class="info"><div class="name">${esc(a.name)}</div><div class="meta">${esc(t.label)}</div></div>
      <div class="amt"${a.balance < 0 ? ' style="color:var(--danger)"' : ''}>${fmt(a.balance)}</div>
    </div>`;
  }).join('');
  scrim.innerHTML = `<div class="sheet">
    <h2>Accounts</h2>
    <div class="hint">Cash, bank and e-wallet balances. These count toward your net worth on the Overview (debt is tracked separately as loans).</div>
    ${S.accountOrder.length ? `<div class="row-space" style="margin-bottom:10px;font-size:13px"><span style="color:var(--soft)">Total liquid</span><b class="mono">${fmt(totalAccounts())}</b></div>` : ''}
    ${list || '<div class="empty" style="padding:14px 0">No accounts yet.</div>'}
    <button class="ghost" id="acc_add" style="width:100%;margin-top:6px">＋ Add account</button>
    <div class="btnrow"><button class="primary" id="acc_close">Done</button></div>
  </div>`;
  scrim.classList.add('open');
  document.getElementById('acc_close').onclick = () => { closeSheet(); renderContent(); };
  document.getElementById('acc_add').onclick = () => openAccountForm(null, openAccounts);
  scrim.querySelectorAll('[data-acc]').forEach((el) => (el.onclick = () => openAccountForm(el.dataset.acc, openAccounts)));
}

export function openAccountForm(editId, onDone) {
  const ex = editId ? S.accounts[editId] : null;
  const selType = ex ? ex.type : 'bank';
  let selColor = ex ? ex.color : nextColor(S.accountOrder);
  scrim.innerHTML = `<div class="sheet">
    <h2>${ex ? 'Edit account' : 'Add account'}</h2>
    <label class="set-label">Account name</label>
    <input class="set-input" id="ac_name" placeholder="e.g. Khan Bank, Cash wallet" value="${ex ? esc(ex.name) : ''}">
    <label class="set-label">Current balance (${esc(CUR.symbol)})</label>
    <input class="set-input mono" id="ac_bal" inputmode="numeric" placeholder="0" value="${ex ? Math.round(ex.balance).toLocaleString('en-US') : ''}">
    <label class="set-label">Type</label>
    <select class="set-input" id="ac_type">
      ${ACCOUNT_TYPES.map((t) => `<option value="${t.id}"${selType === t.id ? ' selected' : ''}>${t.icon} ${t.label}</option>`).join('')}
    </select>
    <label class="set-label">Color</label>
    <div class="color-row" id="ac_colors">${PALETTE.map((p) => `<button class="swatch${p === selColor ? ' sel' : ''}" data-color="${p}" style="background:${p}" aria-label="Pick color"></button>`).join('')}</div>
    <div class="btnrow">
      ${editId ? '<button class="ghost" id="ac_del" style="color:var(--danger)">Delete</button>' : '<button class="ghost" id="ac_cancel">Cancel</button>'}
      <button class="primary" id="ac_save">${ex ? 'Save changes' : 'Add account'}</button>
    </div></div>`;
  scrim.classList.add('open');
  scrim.querySelectorAll('#ac_colors .swatch').forEach((b) => (b.onclick = () => { selColor = b.dataset.color; scrim.querySelectorAll('#ac_colors .swatch').forEach((x) => x.classList.toggle('sel', x === b)); }));
  const cancel = document.getElementById('ac_cancel'); if (cancel) cancel.onclick = () => (onDone ? onDone() : closeSheet());
  const del = document.getElementById('ac_del');
  if (del) del.onclick = async () => {
    if (!(await confirmDialog(`Delete "${S.accounts[editId].name}"?`, { okText: 'Delete', danger: true }))) return;
    S.accountOrder = S.accountOrder.filter((x) => x !== editId); delete S.accounts[editId];
    deleteAccFull(editId); if (onDone) onDone(); else { closeSheet(); renderContent(); }
  };
  document.getElementById('ac_save').onclick = () => {
    const name = (document.getElementById('ac_name').value || '').trim();
    if (!name) { toast('Enter an account name.'); return; }
    // Balance may be negative (overdrawn) — keep a leading minus sign.
    const balance = parseInt((document.getElementById('ac_bal').value || '').replace(/[^\d-]/g, '')) || 0;
    const type = document.getElementById('ac_type').value || 'bank';
    if (editId) {
      const a = S.accounts[editId]; a.name = name; a.balance = balance; a.type = type; a.color = selColor;
      persistAcc(editId);
    } else {
      const id = 'acc_' + Date.now();
      S.accounts[id] = { name, balance, type, color: selColor };
      S.accountOrder.push(id);
      addAcc(id);
    }
    if (onDone) onDone(); else { closeSheet(); renderContent(); }
  };
}

// ── Import / export backup ──────────────────────────────────────────────────────
// Replaces all data on this account with the contents of an exported JSON file.
// Deletes only the cloud docs the import doesn't re-create, then uploads the new
// set (mirrors resetAll, but seeds from the file instead of defaults).
function importReplace(next) {
  const newLoanIds = new Set(Object.keys(next.loans || {}));
  const newSavIds = new Set(Object.keys(next.savings || {}));
  const newSpendIds = new Set((next.spends || []).map((s) => s.id));
  const staleLoan = Object.keys(S.loans || {}).filter((id) => !newLoanIds.has(id));
  const staleSav = Object.keys(S.savings || {}).filter((id) => !newSavIds.has(id));
  const staleSpend = (S.spends || []).map((s) => s.id).filter((id) => !newSpendIds.has(id));
  setS(next); persistLocal();
  if (!canWrite()) return;
  const ops = [];
  staleLoan.forEach((id) => ops.push((b) => b.delete(loanDoc(id))));
  staleSav.forEach((id) => ops.push((b) => b.delete(savDoc(id))));
  staleSpend.forEach((id) => ops.push((b) => b.delete(spendDoc(id))));
  uploadOps(next).forEach((fn) => ops.push(fn));
  trackSync(runChunked(ops));
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (e) { alertDialog('That file isn’t valid JSON.'); return; }
    const looksValid = parsed && typeof parsed === 'object' &&
      ('spends' in parsed || 'loans' in parsed || 'savings' in parsed || 'income' in parsed);
    if (!looksValid) { alertDialog('That doesn’t look like a Fin Plan backup.'); return; }
    if (!(await confirmDialog('Import will REPLACE all current data on this account with the backup. This cannot be undone. Continue?', { okText: 'Import', danger: true }))) return;
    const next = migrate(parsed);
    next.onboarded = true;
    importReplace(next);
    applyCurrency(S.currency);
    closeSheet();
    V.activeTab = 'overview';
    V.view = 'shell';
    renderShell();
    toast('Backup imported');
  };
  input.click();
}

function exportData() {
  try {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'finplan-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) { toast('Export failed.'); }
}

// ── Settings ───────────────────────────────────────────────────────────────
export function openSettings() {
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
  <div style="font-size:11px;color:var(--soft);margin:4px 0 10px">How much you aim to spend on everyday living each month (food, transport, fun…). Loan payments and savings are tracked separately. The Overview compares your actual spending against this.</div>
  <label class="set-label">Currency</label>
  <select class="set-input" id="s_currency">${CURRENCIES.map((c) => `<option value="${c.code}"${S.currency === c.code ? ' selected' : ''}>${c.code} (${c.symbol})</option>`).join('')}</select>
  <div class="divider"></div>
  <div class="btnrow" style="margin-top:0">
    <button class="ghost" id="acctsBtn">🏦 Accounts</button>
    <button class="ghost" id="catsBtn">🏷 Categories</button>
    <button class="ghost" id="recBtn">🔁 Recurring</button>
  </div>
  <div class="divider"></div>
  <div class="row-space" style="margin-bottom:4px">
    <span style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700">Dark mode</span>
    <button class="toggle${getTheme() === 'dark' ? ' on' : ''}" id="themeToggle" role="switch" aria-checked="${getTheme() === 'dark'}"><span class="knob"></span></button>
  </div>
  <div class="divider"></div>
  <div class="btnrow">
    <button class="ghost" id="exportBtn">⬇ Export</button>
    <button class="ghost" id="importBtn">⬆ Import</button>
  </div>
  <div class="btnrow">
    <button class="ghost" id="resetBtn" style="color:var(--danger)">Reset all</button>
    <button class="primary" id="saveSet">Save</button>
  </div>
  <div style="text-align:center;font-size:11px;color:var(--soft);margin-top:14px">
    ${currentUser ? (syncState === 'error' ? '⚠ Not synced to cloud' : '☁ Synced to your Google account') : 'Not signed in'} · v${APP_VERSION}
  </div></div>`;
  scrim.innerHTML = h; scrim.classList.add('open');
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.onclick = doSignOut;
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.onclick = () => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    themeToggle.classList.toggle('on', next === 'dark');
    themeToggle.setAttribute('aria-checked', next === 'dark');
  };
  document.getElementById('exportBtn').onclick = exportData;
  document.getElementById('importBtn').onclick = importData;
  document.getElementById('acctsBtn').onclick = openAccounts;
  document.getElementById('catsBtn').onclick = openCategories;
  document.getElementById('recBtn').onclick = openRecurring;
  document.getElementById('resetBtn').onclick = async () => { if (await confirmDialog('Erase everything? This cannot be undone.', { okText: 'Erase', danger: true })) { resetAll(); closeSheet(); V.view = 'onboarding'; renderOnboarding(); } };
  const gi = (id) => parseInt((document.getElementById(id).value || '').replace(/[^\d]/g, '')) || 0;
  document.getElementById('saveSet').onclick = () => {
    S.income = gi('s_income'); S.budget = gi('s_budget');
    S.currency = document.getElementById('s_currency').value || 'MNT';
    applyCurrency(S.currency);
    persistSettings(); closeSheet(); renderContent(); toast('Settings saved');
  };
}

// ── Auth ───────────────────────────────────────────────────────────────────
export function renderLogin() {
  appEl.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:0 24px">
      <div style="font-size:52px;margin-bottom:16px">₮</div>
      <div class="welcome" style="margin-bottom:8px">Fin Plan</div>
      <div style="color:var(--soft);font-size:13px;margin-bottom:32px;line-height:1.6">Track spending, loans and savings.<br>All in one place.</div>
      ${configured ? `
        <button class="primary" id="signInBtn" style="max-width:280px">Sign in with Google</button>
        <div class="footnote" style="margin-top:16px">Data is private and synced to your Google account.</div>
      ` : `
        <div style="background:#FBE9E7;border-radius:12px;padding:14px 16px;font-size:12px;line-height:1.7;color:#B42318;max-width:320px">
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
    else alertDialog('Sign-in failed: ' + (e.message || e.code));
  }
}
async function doSignOut() { if (await confirmDialog('Sign out?', { okText: 'Sign out' })) await signOut(auth); }

// ── Onboarding ───────────────────────────────────────────────────────────────
export function renderOnboarding() {
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
    if (doneBtn) doneBtn.onclick = () => { S.onboarded = true; persistSettings(); V.view = 'shell'; renderShell(); };
  }
  show();
}
