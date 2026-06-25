// The interactive layer: every bottom-sheet form/detail, the settings sheet,
// the accounts & categories managers, onboarding, and the login screen. Calls
// back into views.js (renderContent / renderShell) to refresh the underlying
// screen — the cycle resolves at runtime.

import { esc, CURRENCIES, APP_VERSION, PALETTE, ACCOUNT_TYPES } from './constants.js';
import {
  S, fmt, fmtShort, allCats, catOf, CUR, todayStr, dateStrFromTs, ord, lc, sc, ac, acctIcon,
  monthLabel, nowAbs, absToTs, simulateLoans, plannedLoans, cloneLoans,
  getInt, nextColor, savMonthsToGoal, savMonthlyInterest, payoffMonths, adjustAccount, applyCurrency,
} from './state.js';
import {
  persistSpend, persistSpendDelete, persistLoan, persistSav, addLoan, addSav,
  deleteLoanFull, deleteSavFull, persistAcc, addAcc, deleteAccFull,
  persistSettings, resetAll,
  currentUser, syncState,
} from './store.js';
import { scrim, appEl, V, closeSheet, toast, confirmDialog, alertDialog, pickDate, getTheme, applyTheme } from './dom.js';
import { renderContent, renderShell } from './views.js';
import { auth, provider, configured } from './firebase.js';
import { signInWithPopup, signInWithRedirect, signOut } from 'firebase/auth';

// Optional "draw from account" picker — only rendered when the user has accounts.
// When a transaction picks an account, its balance is adjusted so net worth stays
// consistent (spending leaves an account; a loan payment moves cash → debt; a
// contribution moves cash → savings).
// ── Themed dropdown ──────────────────────────────────────────────────────────
// A custom <select> replacement: the trigger AND the open option list both follow
// the theme (native <select> popups are OS-drawn and can't be themed). The menu
// expands inline within the sheet flow so it never gets clipped by the sheet's
// own scroll/overflow. `options` is [{ value, html }] — html is rendered as-is, so
// callers must escape any user text themselves.
function selectHTML(id, options, selValue, label) {
  const cur = options.find((o) => o.value === selValue) || options[0];
  const menu = options.map((o) => `<button type="button" class="cselect-opt${o.value === selValue ? ' sel' : ''}" data-val="${esc(o.value)}" role="option">${o.html}</button>`).join('');
  return `${label ? `<label class="set-label">${label}</label>` : ''}
    <div class="cselect" id="${id}_wrap">
      <button type="button" class="set-input cselect-btn" id="${id}_btn" aria-haspopup="listbox" aria-expanded="false">
        <span class="cselect-val">${cur ? cur.html : ''}</span><span class="cselect-caret">▾</span>
      </button>
      <div class="cselect-menu" id="${id}_menu" role="listbox" hidden>${menu}</div>
      <input type="hidden" id="${id}" value="${esc(selValue || '')}">
    </div>`;
}
function closeAllSelects() {
  document.querySelectorAll('.cselect.open').forEach((w) => {
    w.classList.remove('open');
    const m = w.querySelector('.cselect-menu'); if (m) m.hidden = true;
    const b = w.querySelector('.cselect-btn'); if (b) b.setAttribute('aria-expanded', 'false');
  });
}
let _selectCloserAdded = false;
function wireSelect(id, onChange) {
  const wrap = document.getElementById(`${id}_wrap`); if (!wrap) return;
  const btn = document.getElementById(`${id}_btn`);
  const menu = document.getElementById(`${id}_menu`);
  const hidden = document.getElementById(id);
  const valEl = btn.querySelector('.cselect-val');
  if (!_selectCloserAdded) { _selectCloserAdded = true; document.addEventListener('click', () => closeAllSelects()); }
  btn.onclick = (e) => {
    e.stopPropagation();
    // Dismiss the mobile keyboard first — if a text input still holds focus the
    // viewport resizes mid-open and the menu appears to "float"/jump.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const willOpen = menu.hidden;
    closeAllSelects();
    if (willOpen) { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); wrap.classList.add('open'); }
  };
  menu.querySelectorAll('.cselect-opt').forEach((opt) => {
    opt.onclick = (e) => {
      e.stopPropagation();
      hidden.value = opt.dataset.val;
      valEl.innerHTML = opt.innerHTML;
      menu.querySelectorAll('.cselect-opt').forEach((o) => o.classList.toggle('sel', o === opt));
      closeAllSelects();
      if (onChange) onChange(hidden.value);
    };
  });
}

// "Draw from account" picker — only rendered when the user has accounts.
function accountSelectHTML(id, selId, label = 'From account') {
  if (!S.accountOrder.length) return '';
  const opts = [{ value: '', html: '— None —' }];
  S.accountOrder.forEach((aid) => {
    const a = S.accounts[aid];
    if (a) opts.push({ value: aid, html: `${esc(acctIcon(a.type))} ${esc(a.name)}` });
  });
  return selectHTML(id, opts, selId || '', label);
}
const accountVal = (id) => { const el = document.getElementById(id); return el ? (el.value || '') : ''; };
function wireAccountField(id) { wireSelect(id); }
const dateBtnLabel = (ds) => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Wire a date button (id+'_btn') + hidden input (id) to the themed calendar.
function wireDateField(id) {
  const btn = document.getElementById(id + '_btn');
  const hidden = document.getElementById(id);
  if (!btn || !hidden) return;
  btn.onclick = async () => {
    const picked = await pickDate(hidden.value, todayStr());
    if (picked) { hidden.value = picked; btn.textContent = dateBtnLabel(picked); }
  };
}

// ── Add spending sheet ─────────────────────────────────────────────────────────
export function openAddSpend(prefill) {
  let selCat = (prefill && prefill.category) || V.lastCat;
  const catGrid = () => allCats().map((c) => `
    <div class="cat-pick${selCat === c.id ? ' selected' : ''}" data-cat="${esc(c.id)}">
      <span class="icon">${esc(c.icon)}</span>
      <span class="label">${esc(c.label)}</span>
    </div>`).join('') + `<div class="cat-pick cat-new" data-new="1"><span class="icon">＋</span><span class="label">New</span></div>`;

  scrim.innerHTML = `<div class="sheet">
    <h2>Add spending</h2>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="sp_amount" inputmode="numeric" placeholder="0" autocomplete="off" value="${prefill ? prefill.amount : ''}">
    <div class="cat-grid" id="cat_grid">${catGrid()}</div>
    <label class="set-label">Note (optional)</label>
    <input class="set-input" id="sp_note" placeholder="e.g. Lunch, Grocery run…" value="${prefill ? esc(prefill.note || '') : ''}">
    <label class="set-label">Date</label>
    <input type="hidden" id="sp_date" value="${prefill && prefill.date ? esc(prefill.date) : todayStr()}">
    <button class="set-input" id="sp_date_btn" type="button" style="text-align:left;cursor:pointer">${dateBtnLabel(prefill && prefill.date ? prefill.date : todayStr())}</button>
    ${accountSelectHTML('sp_account', prefill && prefill.account)}
    <div class="btnrow">
      <button class="ghost" id="sp_cancel">Cancel</button>
      <button class="primary" id="sp_save">Add</button>
    </div>
  </div>`;
  scrim.classList.add('open');
  document.getElementById('sp_amount').focus();
  document.getElementById('sp_cancel').onclick = closeSheet;
  wireDateField('sp_date');
  wireAccountField('sp_account');
  scrim.querySelectorAll('.cat-pick').forEach((btn) => { btn.onclick = () => {
    // "+ New" tile: create a category inline, then reopen this sheet with the
    // in-progress entry preserved and the new category selected.
    if (btn.dataset.new) {
      const cur = {
        amount: (document.getElementById('sp_amount').value || '').replace(/[^\d]/g, ''),
        note: document.getElementById('sp_note').value,
        date: document.getElementById('sp_date').value,
        account: accountVal('sp_account'),
      };
      openNewCategory((id) => openAddSpend({ ...cur, category: id || selCat }));
      return;
    }
    selCat = btn.dataset.cat;
    scrim.querySelectorAll('.cat-pick').forEach((b) => b.classList.toggle('selected', b.dataset.cat === selCat));
  }; });
  document.getElementById('sp_save').onclick = async () => {
    const amount = Math.floor(parseFloat((document.getElementById('sp_amount').value || '').replace(/[^\d.]/g, '')) || 0);
    if (!amount) { toast('Enter an amount.'); return; }
    const note = (document.getElementById('sp_note').value || '').trim();
    const dateStr = document.getElementById('sp_date').value || todayStr();
    const ts = dateStr === todayStr() ? Date.now() : new Date(dateStr + 'T12:00:00').getTime();
    const ym = dateStr.slice(0, 7);
    const account = accountVal('sp_account');
    // Warn (don't block) if it would overdraw the chosen account.
    if (account) {
      const a = S.accounts[account];
      if (a && amount > a.balance && !(await confirmDialog(`${fmt(amount)} is more than "${a.name}" holds (${fmt(a.balance)}). Add it anyway? The account will go negative.`, { okText: 'Add anyway', danger: true }))) return;
    }
    const id = 'sp_' + Date.now();
    V.lastCat = selCat;
    S.spends.push({ id, ts, month: ym, amount, category: selCat, note, account: account || undefined });
    if (account) { adjustAccount(account, -amount); persistAcc(account); }
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
    <input type="hidden" id="sp_date" value="${dateStrFromTs(sp.ts)}">
    <button class="set-input" id="sp_date_btn" type="button" style="text-align:left;cursor:pointer">${dateBtnLabel(dateStrFromTs(sp.ts))}</button>
    ${accountSelectHTML('sp_account', sp.account)}
    <div class="btnrow">
      <button class="ghost" id="sp_del" style="color:var(--danger)">Delete</button>
      <button class="primary" id="sp_save">Save</button>
    </div>
  </div>`;
  scrim.classList.add('open');
  scrim.querySelectorAll('.cat-pick').forEach((btn) => {
    btn.onclick = () => { selCat = btn.dataset.cat; scrim.querySelectorAll('.cat-pick').forEach((b) => b.classList.toggle('selected', b.dataset.cat === selCat)); };
  });
  wireDateField('sp_date');
  wireAccountField('sp_account');
  document.getElementById('sp_del').onclick = async () => {
    if (!(await confirmDialog('Delete this entry?', { okText: 'Delete', danger: true }))) return;
    if (sp.account) { adjustAccount(sp.account, +sp.amount); persistAcc(sp.account); } // refund the account
    S.spends = S.spends.filter((x) => x.id !== id);
    persistSpendDelete(id); closeSheet(); renderContent();
    toast('Entry deleted');
  };
  document.getElementById('sp_save').onclick = async () => {
    const amount = Math.floor(parseFloat((document.getElementById('sp_amount').value || '').replace(/[^\d.]/g, '')) || 0);
    if (!amount) { toast('Enter an amount.'); return; }
    const note = (document.getElementById('sp_note').value || '').trim();
    const dateStr = document.getElementById('sp_date').value || dateStrFromTs(sp.ts);
    const ts = new Date(dateStr + 'T12:00:00').getTime();
    const month = dateStr.slice(0, 7);
    const account = accountVal('sp_account');
    // Warn (don't block) if it would overdraw the chosen account. The account
    // balance still includes this spend's old deduction, so add it back when the
    // account is unchanged to get what's actually available.
    if (account) {
      const a = S.accounts[account];
      const available = a ? a.balance + (sp.account === account ? sp.amount : 0) : 0;
      if (a && amount > available && !(await confirmDialog(`${fmt(amount)} is more than "${a.name}" holds (${fmt(available)}). Save anyway? The account will go negative.`, { okText: 'Save anyway', danger: true }))) return;
    }
    // Reverse the old account effect, then apply the new one (amount/account may both change).
    if (sp.account) adjustAccount(sp.account, +sp.amount);
    if (account) adjustAccount(account, -amount);
    const affected = [...new Set([sp.account, account].filter(Boolean))];
    const idx = S.spends.findIndex((x) => x.id === id);
    if (idx >= 0) { S.spends[idx] = { ...S.spends[idx], amount, category: selCat, note, ts, month, account: account || undefined }; }
    affected.forEach((aid) => persistAcc(aid));
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
  // simulateLoans() runs the whole portfolio until the LAST loan is paid off, so
  // a short loan's series would keep emitting zeros out to the longest loan's
  // date. Stop this loan's projected line at the month it reaches zero.
  const projected = [];
  for (const sn of sim.snaps) {
    const bal = sn.bals[id] || 0;
    projected.push({ abs: sn.abs, bal });
    if (bal <= 0.5) break;
  }
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
    ${done ? '' : `<div class="whatif">
      <div class="wi-head">What if I pay extra each month?</div>
      <div class="wi-row"><span>Extra / month</span>
        <input class="set-input mono" id="wi_extra" inputmode="numeric" placeholder="0" style="width:130px;text-align:right"></div>
      <div class="wi-out" id="wi_out"></div>
    </div>`}
    ${done ? '' : `<button class="primary" id="logPay" style="width:100%;margin-bottom:10px">＋ Log a payment</button>`}
    ${log.length ? `<button class="ghost" id="undoPay" style="width:100%;margin-bottom:10px;color:var(--danger)">↩ Undo last payment</button>` : ''}
    <div class="btnrow">
      <button class="ghost" id="editLoan">Edit</button>
      <button class="primary" id="closeDet">Close</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('closeDet').onclick = closeSheet;
  document.getElementById('editLoan').onclick = () => { closeSheet(); openLoanForm(id, renderContent); };
  // What-if: how an extra monthly amount shortens this loan's payoff.
  const wiExtra = document.getElementById('wi_extra');
  if (wiExtra) {
    const baseMonthly = Math.round(plannedLoans(cloneLoans())[id] || 0);
    const fmtM = (m) => (m === Infinity ? 'never at this payment' : `${m} month${m === 1 ? '' : 's'}`);
    const renderWhatIf = () => {
      const out = document.getElementById('wi_out');
      if (!baseMonthly) { out.innerHTML = 'Set a monthly payment (Edit) to use this.'; return; }
      const extra = parseInt((wiExtra.value || '').replace(/[^\d]/g, '')) || 0;
      const baseM = payoffMonths(l.bal, l.rate, baseMonthly);
      let txt = `Now: ${fmtShort(baseMonthly)}/mo → ${fmtM(baseM)}`;
      if (extra > 0) {
        const newM = payoffMonths(l.bal, l.rate, baseMonthly + extra);
        const sooner = (baseM === Infinity || newM === Infinity) ? null : baseM - newM;
        txt += `<br>With +${fmtShort(extra)}/mo → ${fmtM(newM)}${sooner != null && sooner > 0 ? ` <b style="color:var(--emerald)">(${sooner} mo sooner)</b>` : ''}`;
      }
      out.innerHTML = txt;
    };
    wiExtra.oninput = renderWhatIf;
    renderWhatIf();
  }
  const logPay = document.getElementById('logPay');
  if (logPay) logPay.onclick = () => openLoanLog(id);
  const undoPay = document.getElementById('undoPay');
  if (undoPay) undoPay.onclick = async () => {
    if (!(await confirmDialog('Undo the most recent logged payment for this loan?', { okText: 'Undo' }))) return;
    const last = l.paidLog.pop();
    if (last) { l.bal = last.prevBal; if (last.account) { adjustAccount(last.account, +last.paid); persistAcc(last.account); } }
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
    ${accountSelectHTML('lp_account', null, 'Paid from account (optional)')}
    <div class="btnrow">
      <button class="ghost" id="lp_cancel">Cancel</button>
      <button class="primary" id="lp_save">Log payment</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('lp_amount').focus();
  scrim.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { document.getElementById('lp_amount').value = Number(c.dataset.v).toLocaleString('en-US'); }));
  document.getElementById('lp_cancel').onclick = () => openLoanDetail(id);
  wireAccountField('lp_account');
  document.getElementById('lp_save').onclick = async () => {
    const paid = parseInt((document.getElementById('lp_amount').value || '').replace(/[^\d]/g, '')) || 0;
    const account = accountVal('lp_account');
    if (account) {
      const acc = S.accounts[account];
      if (acc && paid > acc.balance && !(await confirmDialog(`${fmt(paid)} is more than "${acc.name}" holds (${fmt(acc.balance)}). Log it anyway? The account will go negative.`, { okText: 'Log anyway', danger: true }))) return;
    }
    const prevBal = l.bal;
    const bal = Math.max(0, l.bal * (1 + l.rate) - paid);
    l.paidLog = l.paidLog || [];
    l.paidLog.push({ abs: nowAbs(), paid, prevBal, bal, account: account || undefined });
    l.bal = bal;
    if (account) { adjustAccount(account, -paid); persistAcc(account); }
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
    <div class="hint">${done ? 'Goal reached!' : 'Saving ' + fmtShort(sv.monthly) + '/month'}${sv.rate ? ` · ${+(sv.rate * 100).toFixed(2)}%/yr (~${fmtShort(savMonthlyInterest(id))}/mo)` : ''}</div>
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
    if (last) { sv.current = Math.max(0, sv.current - last.amount); if (last.account) { adjustAccount(last.account, +last.amount); persistAcc(last.account); } }
    persistSav(id); renderContent(); openSavDetail(id);
  };
}

// Per-goal contribution logging: adds to the saved amount (capped at target) and
// records it on the goal's own log, then re-opens the detail.
function openSavLog(id) {
  const sv = S.savings[id]; if (!sv || sv.current >= sv.target) return;
  const planned = Math.round(sv.monthly || 0);
  const interest = Math.round(savMonthlyInterest(id));
  scrim.innerHTML = `<div class="sheet">
    <h2>Log contribution</h2>
    <div class="hint"><span class="dot" style="background:${sc(id)};display:inline-block;width:9px;height:9px;border-radius:50%"></span> ${esc(sv.name)} · ${fmt(sv.current)} of ${fmt(sv.target)}</div>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="cn_amount" inputmode="numeric" value="${planned ? planned.toLocaleString('en-US') : ''}" placeholder="0">
    ${(planned || interest > 0) ? `<div class="quick" style="justify-content:center">
      ${planned ? `<span class="chip" data-v="${planned}">Planned ${fmtShort(planned)}</span>` : ''}
      ${interest > 0 ? `<span class="chip" data-v="${interest}">Interest ${fmtShort(interest)}</span>` : ''}
    </div>` : ''}
    ${interest > 0 ? `<div style="font-size:11px;color:var(--soft);margin-top:8px">Tip: log interest with no account — it's earned, not transferred.</div>` : ''}
    ${accountSelectHTML('cn_account', null, 'From account (optional)')}
    <div class="btnrow">
      <button class="ghost" id="cn_cancel">Cancel</button>
      <button class="primary" id="cn_save">Log contribution</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('cn_amount').focus();
  scrim.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { document.getElementById('cn_amount').value = Number(c.dataset.v).toLocaleString('en-US'); }));
  document.getElementById('cn_cancel').onclick = () => openSavDetail(id);
  wireAccountField('cn_account');
  document.getElementById('cn_save').onclick = async () => {
    const amount = parseInt((document.getElementById('cn_amount').value || '').replace(/[^\d]/g, '')) || 0;
    if (!amount) { toast('Enter an amount.'); return; }
    const account = accountVal('cn_account');
    if (account) {
      const acc = S.accounts[account];
      if (acc && amount > acc.balance && !(await confirmDialog(`${fmt(amount)} is more than "${acc.name}" holds (${fmt(acc.balance)}). Save anyway? The account will go negative.`, { okText: 'Save anyway', danger: true }))) return;
    }
    const prev = sv.current;
    sv.current = Math.min(sv.target, sv.current + amount);
    const added = sv.current - prev;
    sv.contribLog = sv.contribLog || [];
    sv.contribLog.push({ abs: nowAbs(), amount: added, prev, account: account || undefined });
    if (account) { adjustAccount(account, -added); persistAcc(account); }
    persistSav(id); renderContent();
    toast(`Logged ${fmt(added)} · ${sv.name}`);
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
    ${selectHTML('nl_type', [
      { value: 'fixed', html: 'Fixed installment (car, mortgage…)' },
      { value: 'revolving', html: 'Revolving / BNPL (10% min)' },
    ], ex && ex.type === 'revolving' ? 'revolving' : 'fixed', 'Type')}
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
  wireSelect('nl_type', (v) => { document.getElementById('nl_plan_row').style.display = v === 'revolving' ? 'none' : ''; });
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
    <label class="set-label">Annual interest % (optional)</label>
    <input class="set-input mono" id="sv_rate" inputmode="decimal" placeholder="e.g. 12" style="width:120px" value="${ex && ex.rate ? +(ex.rate * 100).toFixed(2) : ''}">
    <div style="font-size:11px;color:var(--soft);margin:4px 0 2px">If this goal sits in an interest-bearing account, its balance grows each month and the goal is reached sooner.</div>
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
    const rate = (parseFloat(document.getElementById('sv_rate').value) || 0) / 100;
    if (editId) {
      const sv = S.savings[editId]; sv.name = name; sv.current = current; sv.target = target; sv.monthly = monthly; sv.rate = rate;
      persistSav(editId);
    } else {
      const id = 'sav_' + Date.now();
      S.savings[id] = { name, current, target, monthly, rate, color: nextColor(S.savingsOrder), contribLog: [] };
      S.savingsOrder.push(id);
      addSav(id);
    }
    closeSheet(); if (onDone) onDone();
  };
}

// ── New category (created inline from the spend category picker) ───────────────
// Categories are created where they're used — when adding a spend — not in a
// separate settings manager. onDone(newId | null) is called when finished.
function openNewCategory(onDone) {
  let selColor = PALETTE[0];
  scrim.innerHTML = `<div class="sheet">
    <h2>New category</h2>
    <label class="set-label">Name</label>
    <input class="set-input" id="nc_name" placeholder="e.g. Pets, Kids, Subscriptions">
    <div class="two" style="margin-top:9px">
      <div><label class="set-label">Emoji / icon</label>
        <input class="set-input" id="nc_icon" placeholder="🏷" maxlength="2"></div>
      <div><label class="set-label">Color</label>
        <div class="color-row" id="nc_colors">${PALETTE.map((p, i) => `<button class="swatch${i === 0 ? ' sel' : ''}" data-color="${p}" style="background:${p}" aria-label="Pick color ${i + 1}"></button>`).join('')}</div></div>
    </div>
    <div class="btnrow">
      <button class="ghost" id="nc_cancel">Cancel</button>
      <button class="primary" id="nc_add">Add category</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('nc_name').focus();
  scrim.querySelectorAll('#nc_colors .swatch').forEach((b) => (b.onclick = () => { selColor = b.dataset.color; scrim.querySelectorAll('#nc_colors .swatch').forEach((x) => x.classList.toggle('sel', x === b)); }));
  document.getElementById('nc_cancel').onclick = () => onDone(null);
  document.getElementById('nc_add').onclick = () => {
    const name = (document.getElementById('nc_name').value || '').trim();
    if (!name) { toast('Enter a category name.'); return; }
    const icon = (document.getElementById('nc_icon').value || '').trim() || '🏷';
    const id = 'cat_' + Date.now();
    S.customCategories = S.customCategories || [];
    S.customCategories.push({ id, label: name, icon, color: selColor });
    persistSettings();
    onDone(id);
  };
}

// ── Add to Accounts chooser (FAB on the Accounts tab) ──────────────────────────
// Asks what kind of thing to add: a plain account (where money sits) or a
// savings goal (a target you fund, with optional interest).
export function openAddBalance() {
  scrim.innerHTML = `<div class="sheet">
    <h2>Add</h2>
    <div class="hint">What would you like to add?</div>
    <button class="ghost ab-opt" id="ab_income">💰 Income
      <span>Salary, freelance or any money received</span></button>
    <button class="ghost ab-opt" id="ab_acct">🏦 Account
      <span>Bank, cash or e-wallet balance</span></button>
    <button class="ghost ab-opt" id="ab_goal">🎯 Saving
      <span>Money set aside toward a goal, with optional interest</span></button>
    <div class="btnrow"><button class="ghost" id="ab_cancel">Cancel</button></div>
  </div>`;
  scrim.classList.add('open');
  document.getElementById('ab_cancel').onclick = closeSheet;
  document.getElementById('ab_income').onclick = () => openAddIncome();
  document.getElementById('ab_acct').onclick = () => openAccountForm(null, renderContent);
  document.getElementById('ab_goal').onclick = () => openSavingsForm(null, renderContent);
}

// Account detail: balance + every transaction drawn from this account
// (spends, loan payments, savings contributions), newest first.
export function openAccountDetail(id) {
  const a = S.accounts[id]; if (!a) return;
  const typeLabel = (ACCOUNT_TYPES.find((t) => t.id === a.type) || ACCOUNT_TYPES[0]).label;
  const items = [];
  for (const sp of S.spends) {
    if (sp.account !== id) continue;
    if (sp.type === 'income') {
      items.push({ ts: sp.ts, title: sp.note || 'Income', meta: 'Income', amount: sp.amount, icon: '💰', color: '#7BE3C0', positive: true });
    } else {
      const c = catOf(sp.category);
      items.push({ ts: sp.ts, title: sp.note || c.label, meta: c.label, amount: sp.amount, icon: c.icon, color: c.color });
    }
  }
  for (const lid of S.loanOrder) {
    const l = S.loans[lid]; if (!l) continue;
    for (const e of (l.paidLog || [])) if (e.account === id) items.push({ ts: absToTs(e.abs), title: 'Loan payment', meta: l.name, amount: e.paid, icon: '🏦', color: '#566072' });
  }
  for (const sid of S.savingsOrder) {
    const sv = S.savings[sid]; if (!sv) continue;
    for (const e of (sv.contribLog || [])) if (e.account === id) items.push({ ts: absToTs(e.abs), title: 'Saving', meta: sv.name, amount: e.amount, icon: '🎯', color: '#147A5C' });
  }
  items.sort((x, y) => y.ts - x.ts);
  const out = items.filter((i) => !i.positive).reduce((s, i) => s + i.amount, 0);
  const totalIn = items.filter((i) => i.positive).reduce((s, i) => s + i.amount, 0);
  const dateLabel = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const rows = items.map((i) => `<div class="spend-item">
    <div class="cat-icon" style="background:${i.color}22">${esc(i.icon)}</div>
    <div class="info"><div class="name">${esc(i.title)}</div><div class="meta">${esc(i.meta)} · ${dateLabel(i.ts)}</div></div>
    <div class="amt"${i.positive ? ' style="color:var(--emerald)"' : ''}>${i.positive ? '+' : '−'}${fmt(i.amount)}</div>
  </div>`).join('');

  scrim.innerHTML = `<div class="sheet">
    <h2><span class="dot" style="background:${ac(id)};width:12px;height:12px;border-radius:50%"></span>${esc(a.name)}</h2>
    <div class="hint">${esc(acctIcon(a.type))} ${esc(typeLabel)} · balance ${fmt(a.balance)}</div>
    <div class="row-space" style="margin-bottom:10px;font-size:12px;color:var(--soft)">
      <span>${items.length} transaction${items.length === 1 ? '' : 's'}</span>
      <span>−${fmt(out)}${totalIn > 0 ? ` / <b style="color:var(--emerald)">+${fmt(totalIn)}</b>` : ''}</span>
    </div>
    ${rows || '<div class="empty" style="padding:14px 0">Nothing drawn from this account yet.<br>Pick it as the source when adding a spend, loan payment or saving.</div>'}
    <div class="btnrow">
      <button class="ghost" id="acd_edit">Edit</button>
      <button class="primary" id="acd_close">Close</button>
    </div></div>`;
  scrim.classList.add('open');
  document.getElementById('acd_close').onclick = closeSheet;
  document.getElementById('acd_edit').onclick = () => openAccountForm(id, () => openAccountDetail(id));
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
    ${selectHTML('ac_type', ACCOUNT_TYPES.map((t) => ({ value: t.id, html: `${t.icon} ${esc(t.label)}` })), selType, 'Type')}
    <label class="set-label">Color</label>
    <div class="color-row" id="ac_colors">${PALETTE.map((p) => `<button class="swatch${p === selColor ? ' sel' : ''}" data-color="${p}" style="background:${p}" aria-label="Pick color"></button>`).join('')}</div>
    <div class="btnrow">
      ${editId ? '<button class="ghost" id="ac_del" style="color:var(--danger)">Delete</button>' : '<button class="ghost" id="ac_cancel">Cancel</button>'}
      <button class="primary" id="ac_save">${ex ? 'Save changes' : 'Add account'}</button>
    </div></div>`;
  scrim.classList.add('open');
  wireSelect('ac_type');
  scrim.querySelectorAll('#ac_colors .swatch').forEach((b) => (b.onclick = () => { selColor = b.dataset.color; scrim.querySelectorAll('#ac_colors .swatch').forEach((x) => x.classList.toggle('sel', x === b)); }));
  // closeSheet() first so onDone can repaint the screen behind (the Accounts tab,
  // onboarding, or overview) cleanly.
  const cancel = document.getElementById('ac_cancel'); if (cancel) cancel.onclick = () => { closeSheet(); if (onDone) onDone(); };
  const del = document.getElementById('ac_del');
  if (del) del.onclick = async () => {
    if (!(await confirmDialog(`Delete "${S.accounts[editId].name}"?`, { okText: 'Delete', danger: true }))) return;
    S.accountOrder = S.accountOrder.filter((x) => x !== editId); delete S.accounts[editId];
    deleteAccFull(editId); closeSheet(); if (onDone) onDone(); else renderContent();
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
    closeSheet(); if (onDone) onDone(); else renderContent();
  };
}

// ── Add / edit income ─────────────────────────────────────────────────────────
export function openAddIncome(prefill) {
  scrim.innerHTML = `<div class="sheet">
    <h2>Add income</h2>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="inc_amount" inputmode="numeric" placeholder="0" autocomplete="off" value="${prefill ? prefill.amount : ''}">
    <label class="set-label">Source (optional)</label>
    <input class="set-input" id="inc_note" placeholder="e.g. Salary, Freelance, Bonus…" value="${prefill ? esc(prefill.note || '') : ''}">
    <label class="set-label">Date</label>
    <input type="hidden" id="inc_date" value="${prefill && prefill.date ? esc(prefill.date) : todayStr()}">
    <button class="set-input" id="inc_date_btn" type="button" style="text-align:left;cursor:pointer">${dateBtnLabel(prefill && prefill.date ? prefill.date : todayStr())}</button>
    ${accountSelectHTML('inc_account', prefill && prefill.account, 'To account (optional)')}
    <div class="btnrow">
      <button class="ghost" id="inc_cancel">Cancel</button>
      <button class="primary" id="inc_save">Add</button>
    </div>
  </div>`;
  scrim.classList.add('open');
  document.getElementById('inc_amount').focus();
  document.getElementById('inc_cancel').onclick = closeSheet;
  wireDateField('inc_date');
  wireAccountField('inc_account');
  document.getElementById('inc_save').onclick = () => {
    const amount = Math.floor(parseFloat((document.getElementById('inc_amount').value || '').replace(/[^\d.]/g, '')) || 0);
    if (!amount) { toast('Enter an amount.'); return; }
    const note = (document.getElementById('inc_note').value || '').trim();
    const dateStr = document.getElementById('inc_date').value || todayStr();
    const ts = dateStr === todayStr() ? Date.now() : new Date(dateStr + 'T12:00:00').getTime();
    const ym = dateStr.slice(0, 7);
    const account = accountVal('inc_account');
    const id = 'inc_' + Date.now();
    S.spends.push({ id, ts, month: ym, amount, note, account: account || undefined, type: 'income' });
    if (account) { adjustAccount(account, +amount); persistAcc(account); }
    persistSpend(id); closeSheet(); renderContent();
    toast(`Income ${fmt(amount)} added`);
  };
}

export function openEditIncome(id) {
  const inc = S.spends.find((x) => x.id === id && x.type === 'income'); if (!inc) return;
  scrim.innerHTML = `<div class="sheet">
    <h2>Edit income</h2>
    <div class="amount-prefix">Amount (${esc(CUR.symbol)})</div>
    <input class="amount-input" id="inc_amount" inputmode="numeric" value="${inc.amount}">
    <label class="set-label">Source (optional)</label>
    <input class="set-input" id="inc_note" value="${esc(inc.note || '')}">
    <label class="set-label">Date</label>
    <input type="hidden" id="inc_date" value="${dateStrFromTs(inc.ts)}">
    <button class="set-input" id="inc_date_btn" type="button" style="text-align:left;cursor:pointer">${dateBtnLabel(dateStrFromTs(inc.ts))}</button>
    ${accountSelectHTML('inc_account', inc.account, 'To account (optional)')}
    <div class="btnrow">
      <button class="ghost" id="inc_del" style="color:var(--danger)">Delete</button>
      <button class="primary" id="inc_save">Save</button>
    </div>
  </div>`;
  scrim.classList.add('open');
  wireDateField('inc_date');
  wireAccountField('inc_account');
  document.getElementById('inc_del').onclick = async () => {
    if (!(await confirmDialog('Delete this income entry?', { okText: 'Delete', danger: true }))) return;
    if (inc.account) { adjustAccount(inc.account, -inc.amount); persistAcc(inc.account); }
    S.spends = S.spends.filter((x) => x.id !== id);
    persistSpendDelete(id); closeSheet(); renderContent();
    toast('Income entry deleted');
  };
  document.getElementById('inc_save').onclick = () => {
    const amount = Math.floor(parseFloat((document.getElementById('inc_amount').value || '').replace(/[^\d.]/g, '')) || 0);
    if (!amount) { toast('Enter an amount.'); return; }
    const note = (document.getElementById('inc_note').value || '').trim();
    const dateStr = document.getElementById('inc_date').value || dateStrFromTs(inc.ts);
    const ts = new Date(dateStr + 'T12:00:00').getTime();
    const month = dateStr.slice(0, 7);
    const account = accountVal('inc_account');
    if (inc.account) adjustAccount(inc.account, -inc.amount);
    if (account) adjustAccount(account, +amount);
    const affected = [...new Set([inc.account, account].filter(Boolean))];
    const idx = S.spends.findIndex((x) => x.id === id);
    if (idx >= 0) S.spends[idx] = { ...S.spends[idx], amount, note, ts, month, account: account || undefined };
    affected.forEach((aid) => persistAcc(aid));
    persistSpend(id); closeSheet(); renderContent();
    toast('Saved');
  };
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
  ${selectHTML('s_currency', CURRENCIES.map((c) => ({ value: c.code, html: `${esc(c.code)} (${esc(c.symbol)})` })), S.currency, 'Currency')}
  <div class="divider"></div>
  <div class="row-space" style="margin-bottom:4px">
    <span style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700">Dark mode</span>
    <button class="toggle${getTheme() === 'dark' ? ' on' : ''}" id="themeToggle" role="switch" aria-checked="${getTheme() === 'dark'}"><span class="knob"></span></button>
  </div>
  <div class="divider"></div>
  <div class="btnrow">
    <button class="ghost" id="resetBtn" style="color:var(--danger)">Reset all</button>
    <button class="primary" id="saveSet">Save</button>
  </div>
  <div style="text-align:center;font-size:11px;color:var(--soft);margin-top:14px">
    ${currentUser ? (syncState === 'error' ? '⚠ Not synced to cloud' : '☁ Synced to your Google account') : 'Not signed in'} · v${APP_VERSION}
  </div>
  <div style="text-align:center;font-size:11px;color:var(--soft);margin-top:6px">
    Made by Mugi · <a href="https://github.com/Munkh99/fin-plan" target="_blank" rel="noopener" style="color:var(--soft);text-decoration:none;display:inline-flex;align-items:center;gap:4px;vertical-align:middle">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      GitHub
    </a>
  </div></div>`;
  scrim.innerHTML = h; scrim.classList.add('open');
  wireSelect('s_currency');
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.onclick = doSignOut;
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.onclick = () => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    themeToggle.classList.toggle('on', next === 'dark');
    themeToggle.setAttribute('aria-checked', next === 'dark');
  };
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
      <div style="color:var(--soft);font-size:13px;margin-bottom:28px;line-height:1.6">Track spending, loans and savings.<br>All in one place.</div>
      ${configured ? `
        <button class="primary" id="signInBtn" style="max-width:280px">Sign in with Google</button>
        <div class="footnote" style="margin-top:16px">Data is private and synced to your Google account.</div>
      ` : `
        <div style="background:#FBE9E7;border-radius:12px;padding:14px 16px;font-size:12px;line-height:1.7;color:#B42318;max-width:320px">
          Firebase not configured. Edit <strong>src/firebase.js</strong>.
        </div>
      `}
      <div class="theme-seg" id="themeSeg" role="group" aria-label="Theme" style="margin-top:32px;margin-bottom:0">
        <button data-t="light"${getTheme() === 'light' ? ' class="on"' : ''}>☀ Light</button>
        <button data-t="dark"${getTheme() === 'dark' ? ' class="on"' : ''}>🌙 Dark</button>
      </div>
    </div>`;
  const seg = document.getElementById('themeSeg');
  if (seg) seg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    applyTheme(b.dataset.t);
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.t === b.dataset.t));
  }));
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
  const STEPS = 5;
  function show() {
    const progress = Array.from({ length: STEPS }, (_, i) => `<div style="height:3px;flex:1;border-radius:3px;background:${i < step ? 'var(--ink)' : 'var(--rule)'}"></div>`).join('');
    let body = '';
    if (step === 1) {
      body = `<div class="welcome" style="margin-bottom:8px">What's your monthly income?</div>
        <div style="color:var(--soft);font-size:13px;margin-bottom:24px">Take-home pay after tax.</div>
        <input class="set-input mono" id="ob_income" inputmode="numeric" placeholder="0" value="${S.income || ''}" style="font-size:22px;padding:14px 16px">
        <div style="margin-top:14px">${selectHTML('ob_currency', CURRENCIES.map((c) => ({ value: c.code, html: `${esc(c.code)} (${esc(c.symbol)})` })), S.currency, 'Currency')}</div>
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
        <div class="btnrow"><button class="ghost" id="ob_back">← Back</button><button class="primary" id="ob_next">${S.savingsOrder.length ? 'Continue →' : 'Skip →'}</button></div>`;
    } else if (step === 5) {
      const rows = S.accountOrder.length === 0 ? `<div class="empty" style="margin:0 0 12px">No accounts added yet.</div>` : S.accountOrder.map((id) => { const a = S.accounts[id]; return !a ? '' : `<div class="ob-item" style="border-left-color:${a.color}"><div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:14px">${esc(acctIcon(a.type))} ${esc(a.name)}</div><div style="font-size:12px;color:var(--soft)">${fmt(a.balance)}</div></div>`; }).join('');
      body = `<div class="welcome" style="margin-bottom:8px">Cash &amp; accounts?</div>
        <div style="color:var(--soft);font-size:13px;margin-bottom:16px">Your bank, cash and e-wallet balances. These power your net worth (and spending can draw from them).</div>
        ${rows}<button class="ghost" id="ob_addacct" style="width:100%;margin-bottom:20px">＋ Add an account</button>
        <div class="btnrow"><button class="ghost" id="ob_back">← Back</button><button class="primary" id="ob_done">Get started →</button></div>`;
    }
    appEl.innerHTML = `<div style="padding:calc(40px + env(safe-area-inset-top)) 16px 0;max-width:400px;margin:0 auto">
      <div style="display:flex;gap:4px;margin-bottom:32px">${progress}</div>${body}</div>`;
    wireSelect('ob_currency');
    const nextBtn = document.getElementById('ob_next');
    if (nextBtn) nextBtn.onclick = () => {
      if (step === 1) {
        S.income = getInt('ob_income');
        const cur = document.getElementById('ob_currency');
        if (cur) { S.currency = cur.value || 'MNT'; applyCurrency(S.currency); }
        persistSettings(); step++; show();
      } else if (step === 2) { S.budget = getInt('ob_budget'); persistSettings(); step++; show(); }
      else { step++; show(); }
    };
    const backBtn = document.getElementById('ob_back');
    if (backBtn) backBtn.onclick = () => { step--; show(); };
    const addLoanBtn = document.getElementById('ob_addloan');
    if (addLoanBtn) addLoanBtn.onclick = () => openLoanForm(null, show);
    const addSavBtn = document.getElementById('ob_addsav');
    if (addSavBtn) addSavBtn.onclick = () => openSavingsForm(null, show);
    const addAcctBtn = document.getElementById('ob_addacct');
    if (addAcctBtn) addAcctBtn.onclick = () => openAccountForm(null, show);
    const doneBtn = document.getElementById('ob_done');
    if (doneBtn) doneBtn.onclick = () => { S.onboarded = true; persistSettings(); V.view = 'shell'; renderShell(); };
  }
  show();
}
