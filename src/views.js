// The read-only view layer: the shell (top bar, tabs, FAB), the four tab
// renderers, the charts/banners, and the render-dispatch + boot-render helpers
// (renderContent / reconcile / renderView / go). Interactive modals live in
// sheets.js; this module calls into them (the cycle is resolved at runtime).

import { esc } from './constants.js';
import {
  S, fmt, fmtShort, allCats, catOf, monthDisplay, nowMonth, monthLabel,
  lc, sc, ac, acctIcon, ord, prevMonth, nextMonthStr,
  simulateLoans, plannedLoans, cloneLoans, freeCash, totalSavingsContrib,
  byCategory, totalForMonth, spendsForMonth, lastMonthsTotals, savMonthsToGoal,
  totalAccounts, pendingRecurring, daysInMonth, applyCurrency, persistLocal,
} from './state.js';
import { currentUser, syncState, persistSpend } from './store.js';
import { appEl, V, toast, alertDialog } from './dom.js';
import {
  openAddSpend, openEditSpend, openLoanForm, openSavingsForm, openLoanDetail,
  openSavDetail, openSettings, openRecurring, openAccounts, openAccountForm,
  renderOnboarding, renderLogin,
} from './sheets.js';

// ── Shell ───────────────────────────────────────────────────────────────────
export function renderShell() {
  appEl.innerHTML = `
    <div class="topbar-wrap">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="title">Fin Plan</div>
        <span class="sync-dot" id="syncDot" role="status" aria-label="Sync status"></span>
      </div>
      <div id="topbar-right"></div>
    </div>
    <div class="content" id="content"></div>
    <nav class="tabbar">
      <button class="tab-btn${V.activeTab === 'overview' ? ' active' : ''}" data-tab="overview">
        <span class="tab-icon">📊</span>Overview
      </button>
      <button class="tab-btn${V.activeTab === 'spending' ? ' active' : ''}" data-tab="spending">
        <span class="tab-icon">💸</span>Spending
      </button>
      <button class="tab-btn${V.activeTab === 'loans' ? ' active' : ''}" data-tab="loans">
        <span class="tab-icon">🏦</span>Loans
      </button>
      <button class="tab-btn${V.activeTab === 'savings' ? ' active' : ''}" data-tab="savings">
        <span class="tab-icon">💰</span>Savings
      </button>
    </nav>
    <button class="fab" id="fab" title="Add spending" aria-label="Add spending">＋</button>`;

  appEl.querySelectorAll('.tab-btn').forEach((btn) => (btn.onclick = () => {
    V.activeTab = btn.dataset.tab;
    appEl.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === V.activeTab));
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
  const m = map[V.activeTab] || map.overview;
  fab.title = m.t;
  fab.setAttribute('aria-label', m.t);
  fab.onclick = m.fn;
}

function renderTopbarRight() {
  const el = document.getElementById('topbar-right');
  if (!el) return;
  if (currentUser && currentUser.photoURL) {
    el.innerHTML = `<img class="avatar" id="settingsBtn" src="${esc(currentUser.photoURL)}" alt="Open settings" role="button" tabindex="0">`;
  } else {
    el.innerHTML = `<button class="iconbtn" id="settingsBtn" aria-label="Settings">⚙</button>`;
  }
  document.getElementById('settingsBtn').onclick = openSettings;
}

export function renderContent() {
  const el = document.getElementById('content');
  if (!el) return;
  if (V.activeTab === 'overview') renderOverview(el);
  else if (V.activeTab === 'spending') renderSpending(el);
  else if (V.activeTab === 'loans') renderLoans(el);
  else if (V.activeTab === 'savings') renderSavingsTab(el);
}

export function updateSyncDot() {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot' + (syncState === 'syncing' ? ' syncing' : syncState === 'error' ? ' error' : '');
  dot.title = syncState === 'idle' ? 'Synced to cloud' : syncState === 'syncing' ? 'Saving…' : 'Not synced — tap for help';
  dot.setAttribute('aria-label', dot.title);
  dot.onclick = syncState === 'error'
    ? () => alertDialog('Your changes are saved on this device but could not be saved to the cloud. See the browser console for the exact error.')
    : null;
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function renderOverview(el) {
  const ym = nowMonth();
  const spent = totalForMonth(ym);
  const pct = S.budget > 0 ? Math.min(100, (spent / S.budget) * 100) : 0;
  const left = S.budget - spent;
  const free = freeCash();
  const cats = byCategory(ym);
  const topCats = allCats().filter((c) => cats[c.id]).sort((a, b) => cats[b.id] - cats[a.id]).slice(0, 4);
  const totalDebt = S.loanOrder.reduce((s, id) => s + (S.loans[id] ? S.loans[id].bal : 0), 0);
  const totalSaved = S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].current : 0), 0);
  const liquid = totalAccounts();
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

  h += recurringBannerHTML(ym);

  if (topCats.length) {
    h += `<div style="background:var(--card);border-radius:14px;padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)">
      <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:13px;margin-bottom:8px">Top spending</div>`;
    for (const c of topCats) {
      const amt = cats[c.id] || 0;
      const barW = spent > 0 ? Math.round((amt / spent) * 100) : 0;
      h += `<div class="cat-row">
        <div class="icon" style="background:${c.color}22">${esc(c.icon)}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between">
            <span class="label" style="font-size:12px">${esc(c.label)}</span>
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

  // Accounts (liquid money) — list with balances, tap to manage.
  if (S.accountOrder.length) {
    h += `<div class="acct-card" id="goAccounts">
      <div class="acct-head"><span>Accounts</span><span class="mono">${fmtShort(liquid)}</span></div>`;
    for (const id of S.accountOrder) {
      const a = S.accounts[id]; if (!a) continue;
      h += `<div class="acct-row">
        <span class="al"><span class="ai" style="background:${ac(id)}22">${esc(acctIcon(a.type))}</span>${esc(a.name)}</span>
        <span class="mono" style="font-weight:600${a.balance < 0 ? ';color:var(--danger)' : ''}">${fmt(a.balance)}</span>
      </div>`;
    }
    h += `</div>`;
  } else {
    h += `<button class="ghost" id="addAccount" style="width:100%;margin-bottom:12px">＋ Add a cash / bank account</button>`;
  }

  // Net worth (liquid accounts + savings − debt)
  if (S.accountOrder.length || S.savingsOrder.length || S.loanOrder.length) {
    const net = liquid + totalSaved - totalDebt;
    const plus = [];
    if (liquid) plus.push(`Cash ${fmtShort(liquid)}`);
    if (totalSaved) plus.push(`Savings ${fmtShort(totalSaved)}`);
    const sub = `${plus.join(' + ') || 'Net'}${totalDebt ? ` − Debt ${fmtShort(totalDebt)}` : ''}`;
    h += `<div class="networth">
      <div><div class="k">Net worth</div><div class="sub" style="text-align:left;margin-top:2px">${sub}</div></div>
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
  if (goL) goL.onclick = () => { V.activeTab = 'loans'; renderShell(); };
  if (goS) goS.onclick = () => { V.activeTab = 'savings'; renderShell(); };
  const goA = document.getElementById('goAccounts');
  if (goA) goA.onclick = () => openAccounts();
  const addA = document.getElementById('addAccount');
  if (addA) addA.onclick = () => openAccountForm(null, renderContent);
  wireRecurringBanner(ym);
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
  const items = spendsForMonth(V.spendMonth);
  const total = items.reduce((s, sp) => s + sp.amount, 0);
  const cats = byCategory(V.spendMonth);
  const isNow = V.spendMonth === nowMonth();

  const byDay = {};
  for (const sp of [...items].sort((a, b) => b.ts - a.ts)) {
    const d = new Date(sp.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (byDay[key] = byDay[key] || []).push(sp);
  }

  let h = `<div class="month-nav">
    <button id="mn_prev">‹</button>
    <div class="label">${monthDisplay(V.spendMonth)}</div>
    <button id="mn_next" ${isNow ? 'style="opacity:.3;pointer-events:none"' : ''}>›</button>
  </div>`;

  if (isNow) h += recurringBannerHTML(V.spendMonth);

  if (items.length === 0) {
    h += `<div class="empty">No spending in ${monthDisplay(V.spendMonth)}.<br>Tap ＋ to add an entry.</div>`;
  } else {
    h += `<div style="background:var(--card);border-radius:14px;padding:13px 16px;margin-bottom:14px;box-shadow:var(--shadow);display:flex;justify-content:space-between;align-items:center">
      <div><div style="font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em">Total spent</div>
        <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:26px">${fmt(total)}</div></div>
      ${S.budget > 0 ? `<div style="text-align:right">
        <div style="font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em">Budget</div>
        <div style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:18px;color:${total > S.budget ? 'var(--danger)' : 'var(--emerald)'}">${fmtShort(S.budget)}</div>
      </div>` : ''}
    </div>`;

    const sortedCats = allCats().filter((c) => cats[c.id]).sort((a, b) => cats[b.id] - cats[a.id]);
    if (sortedCats.length) {
      h += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">`;
      for (const c of sortedCats) {
        const b = S.catBudgets[c.id];
        const over = b && cats[c.id] > b;
        h += `<div style="display:flex;align-items:center;gap:5px;background:var(--card);border-radius:20px;padding:5px 10px;font-size:11px;box-shadow:var(--shadow);${over ? 'color:var(--danger)' : ''}">
          <span>${esc(c.icon)}</span><span style="font-weight:600">${fmtShort(cats[c.id])}${b ? ` / ${fmtShort(b)}` : ''}</span>${over ? ' ⚠' : ''}
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
        const c = catOf(sp.category);
        const note = esc(sp.note);
        const hay = esc(((sp.note || '') + ' ' + c.label).toLowerCase());
        h += `<div class="spend-item" data-spend="${esc(sp.id)}" data-search="${hay}">
          <div class="cat-icon" style="background:${c.color}22">${esc(c.icon)}</div>
          <div class="info">
            <div class="name">${note || esc(c.label)}</div>
            <div class="meta">${esc(c.label)}${sp.note && sp.note !== c.label ? ' · ' + note : ''}</div>
          </div>
          <div class="amt">${fmt(sp.amount)}</div>
        </div>`;
      }
      h += `</div>`;
    }
  }

  el.innerHTML = h;
  document.getElementById('mn_prev').onclick = () => { V.spendMonth = prevMonth(V.spendMonth); renderContent(); };
  document.getElementById('mn_next').onclick = () => { V.spendMonth = nextMonthStr(V.spendMonth); renderContent(); };
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
  if (isNow) wireRecurringBanner(V.spendMonth);
}

// ── Loans tab ───────────────────────────────────────────────────────────────
function renderLoans(el) {
  const plan = plannedLoans(cloneLoans());
  const sim = S.loanOrder.length ? simulateLoans() : null;
  let h = `<div class="seclabel"><div class="t">Loans</div></div>`;

  if (!S.loanOrder.length) {
    h += `<div class="empty">No loans tracked.<br>Tap ＋ to add your first loan.</div>`;
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
    h += `<div class="empty" style="padding:10px 0 0">Tap a loan to see its detail and log a payment.</div>`;
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-loan]').forEach((e) => (e.onclick = () => openLoanDetail(e.dataset.loan)));
}

// ── Savings tab ───────────────────────────────────────────────────────────────
function renderSavingsTab(el) {
  const totalSaved = S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].current : 0), 0);
  const totalTarget = S.savingsOrder.reduce((s, id) => s + (S.savings[id] ? S.savings[id].target : 0), 0);
  let h = `<div class="seclabel"><div class="t">Savings goals</div></div>`;
  if (!S.savingsOrder.length) {
    h += `<div class="empty">No savings goals yet.<br>Tap ＋ to create one.</div>`;
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
  el.querySelectorAll('[data-sav]').forEach((e) => (e.onclick = () => openSavDetail(e.dataset.sav)));
}

// ── Recurring banner (shown on the current month only) ─────────────────────────
function recurringBannerHTML(ym) {
  const pend = pendingRecurring(ym);
  if (!pend.length) return '';
  const sum = pend.reduce((s, r) => s + r.amount, 0);
  return `<div class="rec-banner">
    <div><div class="rec-t">🔁 ${pend.length} recurring ${pend.length === 1 ? 'entry' : 'entries'}</div>
      <div class="rec-s">${fmtShort(sum)} · not added to ${monthDisplay(ym)} yet</div></div>
    <button class="rec-add" id="recApply">Add all</button>
  </div>`;
}
function wireRecurringBanner(ym) {
  const btn = document.getElementById('recApply');
  if (btn) btn.onclick = () => applyRecurring(ym);
}
// Materialises every pending template for the month into ordinary spends tagged
// rec:<id> (so they stay editable/deletable and the apply is idempotent).
function applyRecurring(ym) {
  const pend = pendingRecurring(ym);
  if (!pend.length) return;
  const dim = daysInMonth(ym);
  pend.forEach((r, i) => {
    const day = Math.min(Math.max(1, r.day || 1), dim);
    const id = 'sp_' + Date.now() + '_' + i;
    const ts = new Date(`${ym}-${String(day).padStart(2, '0')}T12:00:00`).getTime();
    S.spends.push({ id, ts, month: ym, amount: r.amount, category: r.category, note: r.note || '', rec: r.id });
    persistSpend(id);
  });
  renderContent();
  toast(`Added ${pend.length} recurring ${pend.length === 1 ? 'entry' : 'entries'}`);
}

// ── Render dispatch / boot ────────────────────────────────────────────────────
// Re-render the right view when remote data lands. Modals live in #scrim and are
// untouched; only the underlying view (#content) is refreshed.
export function reconcile() {
  persistLocal();
  applyCurrency(S.currency);
  if (!currentUser) return;
  if (!S.onboarded) {
    if (V.view !== 'onboarding') { V.view = 'onboarding'; renderOnboarding(); }
  } else if (V.view !== 'shell') {
    V.view = 'shell'; renderShell();
  } else {
    renderContent();
  }
}

// Render the app view from current state. Assumes a signed-in user — used by the
// optimistic boot (before auth resolves) and after auth confirms.
export function renderView() {
  applyCurrency(S.currency);
  if (!S.onboarded) { V.view = 'onboarding'; renderOnboarding(); }
  else { V.view = 'shell'; renderShell(); }
  V.booted = true;
}
export function go() {
  if (!currentUser) { V.view = 'login'; renderLogin(); return; }
  renderView();
}
