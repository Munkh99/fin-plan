if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

(function(){
  // FIREBASE_CONFIG is loaded from config.js
  const configured = FIREBASE_CONFIG.apiKey !== 'REPLACE_ME';
  let auth, db, currentUser = null;

  if (configured) {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  }

  const KEY     = 'payoff_v2';
  const PALETTE = ['#C2410C','#147A5C','#2B2D77','#566072','#7C3AED','#B45309','#0369A1','#BE185D'];
  const BASE    = 2026*12+5;

  let syncState = 'idle'; // idle | syncing | error

  // ── Storage ───────────────────────────────────────────────────────────────
  async function load() {
    if (db && currentUser) {
      try {
        const snap = await db.collection('users').doc(currentUser.uid).get();
        if (snap.exists && snap.data().payload) {
          const data = JSON.parse(snap.data().payload);
          try { localStorage.setItem(KEY, snap.data().payload); } catch(e) {}
          return data;
        }
      } catch(e) {}
    }
    try { const v = localStorage.getItem(KEY); if (v) return JSON.parse(v); } catch(e) {}
    return null;
  }

  async function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch(e) {}
    if (db && currentUser) {
      syncState = 'syncing'; updateSyncDot();
      try {
        await db.collection('users').doc(currentUser.uid).set({
          payload:   JSON.stringify(s),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        syncState = 'idle';
      } catch(e) {
        syncState = 'error';
      }
      updateSyncDot();
    }
  }

  function updateSyncDot() {
    const dot = document.getElementById('syncDot');
    if (!dot) return;
    dot.className = 'sync-dot' + (syncState === 'syncing' ? ' syncing' : '');
    dot.title = syncState === 'idle' ? 'Synced' : syncState === 'syncing' ? 'Saving…' : 'Sync error — saved locally';
  }

  // ── State & migration ─────────────────────────────────────────────────────
  function defaults() {
    const now = new Date();
    return { startAbs: now.getFullYear()*12+now.getMonth()-BASE, cursor:0, income:0, expenses:0, loans:{}, order:[], history:[] };
  }
  let S = defaults();

  function migrate(s) {
    if (!s) return s;
    const typeMap = { toki:'revolving', inst:'fixed' };
    for (const id of (s.order||[])) {
      const l = s.loans && s.loans[id]; if (!l) continue;
      if (typeMap[l.type]) l.type = typeMap[l.type];
      if (!l.color) l.color = PALETTE[(s.order||[]).indexOf(id) % PALETTE.length];
      if (!l.orig && l.bal) l.orig = l.bal;
    }
    return s;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const fmt      = n => '₮'+Math.round(n).toLocaleString('en-US');
  const fmtShort = n => { n=Math.round(n); return n>=1e6?'₮'+(n/1e6).toFixed(n%1e6?1:0)+'M':'₮'+n.toLocaleString('en-US'); };
  const monthLabel = abs => { const t=BASE+abs; return `${Math.floor(t/12)}.${String((t%12)+1).padStart(2,'0')}`; };
  const ac  = id => (S.loans[id] && S.loans[id].color) || '#566072';
  const ord = d  => d+(d===1?'st':d===2?'nd':d===3?'rd':'th');

  // ── Finance logic ─────────────────────────────────────────────────────────
  function plannedFor(L, income, expenses) {
    const out = {};
    for (const id of S.order) {
      const l = L[id]; if (!l||l.bal<=0.5) { out[id]=0; continue; }
      if (l.type==='fixed') out[id] = Math.min(l.plan, l.bal*(1+l.rate));
    }
    const rev = S.order.filter(id => L[id]&&L[id].bal>0.5&&L[id].type==='revolving');
    const mins = {};
    for (const id of rev) { const l=L[id]; mins[id]=l.bal*l.rate+l.bal*0.10; }
    const fixedSum = S.order.reduce((s,id)=>(out[id]||0)+s, 0);
    const minSum   = rev.reduce((s,id)=>mins[id]+s, 0);
    let surplus = Math.max(0, (income-expenses)-fixedSum-minSum);
    for (let i=0; i<rev.length; i++) {
      const id=rev[i], l=L[id];
      out[id] = Math.min(l.bal*(1+l.rate), i===0 ? mins[id]+surplus : mins[id]);
    }
    return out;
  }
  function clone(loans) { const L={}; for(const k in loans) L[k]={...loans[k]}; return L; }
  function simulate() {
    const L=clone(S.loans); const snaps=[]; let guard=0, abs=S.startAbs+S.cursor, totalInt=0;
    const any    = () => S.order.some(id=>L[id]&&L[id].bal>0.5);
    const hasPlan = () => S.order.some(id=>{ const l=L[id]; if(!l||l.bal<=0.5)return false; return l.type==='revolving'||(l.type==='fixed'&&l.plan>0); });
    while (any()&&guard<1200&&hasPlan()) {
      snaps.push({ abs, bals: Object.fromEntries(S.order.map(id=>[id,L[id]?L[id].bal:0])) });
      const plan = plannedFor(L, S.income, S.expenses);
      if (S.order.reduce((s,id)=>s+(plan[id]||0),0)<=0) break;
      for (const id of S.order) { const l=L[id]; if(!l||l.bal<=0.5){if(l)l.bal=0;continue;} totalInt+=l.bal*l.rate; l.bal=Math.max(0,l.bal*(1+l.rate)-(plan[id]||0)); }
      abs++; guard++;
    }
    snaps.push({ abs, bals: Object.fromEntries(S.order.map(id=>[id,L[id]?Math.max(0,L[id].bal):0])) });
    return { snaps, months:guard, totalInt, payoffAbs:S.startAbs+S.cursor+Math.max(0,guard-1) };
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const appEl = document.getElementById('app');
  const scrim = document.getElementById('scrim');
  let lastDate = null;

  // ── Login screen ──────────────────────────────────────────────────────────
  function renderLogin() {
    appEl.innerHTML = `
      <div style="padding:60px 16px 0;text-align:center">
        <div style="font-size:52px;line-height:1;margin-bottom:16px">₮</div>
        <div class="welcome" style="text-align:center;margin-bottom:10px">Loan Payoff</div>
        ${configured ? `
          <div style="color:var(--soft);font-size:13px;margin-bottom:28px">Sign in to sync across devices.<br>Works offline too.</div>
          <button class="primary" id="signInBtn" style="max-width:280px;margin:0 auto">Sign in with Google</button>
          <div class="footnote" style="margin-top:16px">Your data is linked to your Google account and stored in Firebase. Nothing is shared.</div>
        ` : `
          <div style="color:var(--soft);font-size:13px;margin-bottom:16px">Firebase is not configured yet.</div>
          <div style="background:#FBE9E7;border-radius:12px;padding:14px 16px;text-align:left;font-size:12px;line-height:1.7;color:var(--danger)">
            Open <strong>index.html</strong> and replace the <code>FIREBASE_CONFIG</code> values.<br>
            Follow the setup instructions in the comments above the config.
          </div>
        `}
      </div>`;
    if (configured) {
      document.getElementById('signInBtn').onclick = signIn;
    }
  }

  async function signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const btn = document.getElementById('signInBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    try {
      await auth.signInWithPopup(provider);
    } catch(e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in with Google'; }
      const redirect = ['auth/popup-blocked','auth/popup-closed-by-user','auth/cancelled-popup-request'];
      if (redirect.includes(e.code)) {
        await auth.signInWithRedirect(provider);
      } else {
        alert('Sign-in failed: ' + (e.message || e.code));
      }
    }
  }

  async function doSignOut() {
    if (confirm('Sign out? Your data stays saved locally.')) {
      await auth.signOut();
    }
  }

  // ── Main render ───────────────────────────────────────────────────────────
  function avatarHtml() {
    if (!currentUser) return `<button class="iconbtn" id="settingsBtn">⚙</button>`;
    const img = currentUser.photoURL
      ? `<img class="avatar" id="settingsBtn" src="${currentUser.photoURL}" alt="">`
      : `<button class="iconbtn" id="settingsBtn">⚙</button>`;
    return img;
  }

  function render() {
    const totalBal = S.order.reduce((s,id)=>s+(S.loans[id]?S.loans[id].bal:0), 0);
    let html = `<div class="topbar">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="title">Loan Payoff</div>
        <span class="sync-dot" id="syncDot" title="Synced"></span>
      </div>
      ${avatarHtml()}
    </div>`;

    if (S.order.length === 0) {
      html += `<div class="hero"><div class="eyebrow">Welcome</div>
        <div class="welcome">Track your<br>debt payoff</div>
        <div class="sub" style="margin-top:11px">Add your loans — any kind, any lender. Set your income and budget. Data syncs to all your devices.</div></div>
        <div class="btnrow"><button class="primary" id="addFirst">＋ Add your first loan</button></div>
        <div class="footnote">Synced via Firebase · backed up automatically.</div>`;
      appEl.innerHTML = html;
      document.getElementById('settingsBtn').onclick = openSettings;
      document.getElementById('addFirst').onclick = () => openAddLoan(false);
      updateSyncDot();
      return;
    }

    if (totalBal <= 0.5) {
      html += `<div class="cele"><div class="big">🎉 Debt-free!</div><div>Every loan is paid off. Nicely done.</div></div>
        <div class="btnrow"><button class="ghost" id="undoBtn">↩ Undo last month</button></div>
        <div class="footnote">Data synced via Firebase.</div>`;
      appEl.innerHTML = html;
      document.getElementById('settingsBtn').onclick = openSettings;
      document.getElementById('undoBtn').onclick = undo;
      updateSyncDot();
      return;
    }

    const sim      = simulate();
    const plan     = plannedFor(clone(S.loans), S.income, S.expenses);
    const loanTot  = S.order.reduce((s,id)=>s+(plan[id]||0), 0);
    const leftToLive = S.income - loanTot;
    const curMonth = monthLabel(S.startAbs+S.cursor);
    const totalSpan = S.cursor+sim.months;
    const pct      = totalSpan ? Math.min(100,(S.cursor/totalSpan)*100) : 100;
    const payoff   = monthLabel(sim.payoffAbs);
    const flash    = (lastDate && lastDate!==payoff) ? ' flash' : ''; lastDate=payoff;

    html += `<div class="hero">
      <div class="eyebrow">Debt-free by</div>
      <div class="date${flash}" id="payoffDate">${payoff}</div>
      <div class="sub"><b>${sim.months}</b> payments left · starting <b>${curMonth}</b></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="barlabel"><span>${S.cursor} paid</span><span>${totalSpan} total</span></div></div>
    <div class="stats">
      <div class="stat"><div class="k">Total balance</div><div class="v mono">${fmtShort(totalBal)}</div></div>
      <div class="stat"><div class="k">Interest left</div><div class="v mono">${fmtShort(sim.totalInt)}</div></div></div>
    <div class="seclabel"><div class="t">Loans</div><div class="m mono">${curMonth}</div></div>`;

    for (const id of S.order) {
      const l = S.loans[id]; if (!l) continue;
      const done = l.bal<=0.5;
      const prog = l.orig>0 ? Math.min(100,(1-l.bal/l.orig)*100) : 0;
      const ratePct = (l.rate*100).toFixed(2).replace(/\.?0+$/,'')+'%/mo';
      html += `<div class="loan${done?' done':''}" style="--ac:${ac(id)}" data-loan="${id}">
        <div class="top">
          <div class="name"><span class="dot"></span>${l.name}</div>
          <div class="tags">
            ${done?'<span class="donetag">✓ Paid</span>':`<span class="tag">${ratePct}</span>`}
            ${l.payDay?`<span class="tag">due ${ord(l.payDay)}</span>`:''}
            <span class="chev">›</span>
          </div>
        </div>`;
      if (!done) {
        html += `<div class="balrow">
          <div><div style="font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em">Balance</div>
            <div class="bal mono">${fmt(l.bal)}</div></div>
          <div class="plan">pay this month<b class="mono">${fmt(plan[id]||0)}</b></div></div>
        <div class="lprog"><span style="width:${prog}%"></span></div>`;
      }
      html += `</div>`;
    }

    const liveCls   = leftToLive>=S.expenses ? '' : (leftToLive>=0 ? ' warn' : ' bad');
    const spends    = S.history.filter(h=>typeof h.spend==='number');
    const lastSpend = spends.length ? spends[spends.length-1].spend : null;
    const bpct      = lastSpend!=null&&S.expenses>0 ? Math.min(100,(lastSpend/S.expenses)*100) : 0;
    const over      = lastSpend!=null && lastSpend>S.expenses;

    html += `<div class="live${liveCls}">
      <div><div class="k">Left to live on</div>
        <div class="sub">${leftToLive<0?'Over your income':'After all loan payments'}</div></div>
      <div class="v mono" style="color:${leftToLive<0?'var(--danger)':leftToLive>=S.expenses?'var(--emerald)':'var(--burnt)'}">${fmt(leftToLive)}</div></div>
    <div class="seclabel"><div class="t">Monthly budget</div><div class="m mono">target ${fmtShort(S.expenses)}</div></div>
    <div class="budget" id="budgetCard">
      <div class="row"><span class="k">Last month spent</span>
        <span class="v mono" style="color:${lastSpend==null?'var(--faint)':(over?'var(--danger)':'var(--emerald)')}">${lastSpend==null?'—':fmt(lastSpend)}</span></div>
      <div class="bbar"><span style="width:${bpct}%;background:${over?'var(--danger)':'var(--indigo)'}"></span></div>
      <div class="row" style="margin-top:7px">
        <span style="font-size:11px;color:var(--soft)">${spends.length} month${spends.length===1?'':'s'} tracked</span>
        <span style="font-size:11px;color:var(--soft)">tap for history ›</span></div></div>
    <div class="btnrow">
      <button class="primary" id="logBtn">＋ Log this month</button>
      ${S.cursor>0?'<button class="ghost" id="undoBtn" style="flex:0 0 auto">↩</button>':''}
    </div>
    <div class="footnote">Estimates use monthly compounding. Your bank statement is the exact source of truth.<br>Synced via Firebase · offline-ready.</div>`;

    appEl.innerHTML = html;
    document.getElementById('settingsBtn').onclick = openSettings;
    document.getElementById('logBtn').onclick = openLog;
    const ub = document.getElementById('undoBtn'); if (ub) ub.onclick = undo;
    document.getElementById('budgetCard').onclick = openBudget;
    appEl.querySelectorAll('[data-loan]').forEach(el => el.onclick=()=>openDetail(el.dataset.loan));
    if (document.querySelector('.date.flash')) setTimeout(()=>{ const d=document.getElementById('payoffDate'); if(d)d.classList.remove('flash'); },650);
    updateSyncDot();
  }

  // ── Chart ─────────────────────────────────────────────────────────────────
  function drawChart(actual, projected, id) {
    const W=320,H=150,Lp=10,Rp=10,Tp=12,Bp=22;
    const all = actual.concat(projected);
    if (all.length<2) return '<div class="empty">Log a payment to see the trend line.</div>';
    const xs=all.map(p=>p.abs), ys=all.map(p=>p.bal);
    const minX=Math.min(...xs),maxX=Math.max(...xs),maxY=Math.max(...ys,1);
    const x = a => Lp+(maxX===minX?0:(a-minX)/(maxX-minX))*(W-Lp-Rp);
    const y = b => Tp+(1-b/maxY)*(H-Tp-Bp);
    const path = arr => arr.map((p,i)=>(i?'L':'M')+x(p.abs).toFixed(1)+' '+y(p.bal).toFixed(1)).join(' ');
    const col = ac(id), baseY = y(0);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
    s += `<line x1="${Lp}" y1="${baseY}" x2="${W-Rp}" y2="${baseY}" stroke="var(--rule)" stroke-width="1"/>`;
    if (actual.length>=2) {
      s += `<path d="${path(actual)} L${x(actual[actual.length-1].abs).toFixed(1)} ${baseY} L${x(actual[0].abs).toFixed(1)} ${baseY}Z" fill="${col}" opacity="0.08"/>`;
      s += `<path d="${path(actual)}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    if (projected.length>=2) s += `<path d="${path(projected)}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="4 4" opacity="0.45"/>`;
    const cur = actual[actual.length-1];
    s += `<circle cx="${x(cur.abs).toFixed(1)}" cy="${y(cur.bal).toFixed(1)}" r="3.6" fill="${col}"/>`;
    s += `<text x="${Lp}" y="${H-6}" font-size="9" fill="var(--faint)">${monthLabel(minX)}</text>`;
    s += `<text x="${W-Rp}" y="${H-6}" font-size="9" fill="var(--faint)" text-anchor="end">${monthLabel(maxX)}</text></svg>`;
    return s;
  }

  // ── Loan detail sheet ─────────────────────────────────────────────────────
  function openDetail(id) {
    const l = S.loans[id]; if (!l) return;
    const actual = [];
    for (let k=0; k<S.cursor; k++) { const h=S.history[k]; if(h&&h.prev&&typeof h.prev[id]==='number') actual.push({abs:S.startAbs+k,bal:h.prev[id]}); }
    actual.push({abs:S.startAbs+S.cursor, bal:l.bal});
    const sim = simulate();
    const projected = sim.snaps.map(sn=>({abs:sn.abs, bal:sn.bals[id]||0}));
    let intPaid=0, paysMade=0;
    for (let k=0; k<S.cursor; k++) { const h=S.history[k]; if(!h)continue; intPaid+=((h.prev&&h.prev[id])||0)*l.rate; if(h.pays&&h.pays[id]>0)paysMade++; }
    const pct  = l.orig>0 ? Math.round((1-l.bal/l.orig)*100) : 0;
    const hit  = projected.find(p=>p.bal<=0.5);
    const gone = l.bal<=0.5 ? 'Paid off' : hit ? monthLabel(hit.abs) : '—';
    const ratePct = (l.rate*100).toFixed(2).replace(/\.?0+$/,'')+'%/mo';
    const typeLabel = l.type==='revolving'?'Revolving (10% min + interest)':'Fixed installment';
    let h = `<div class="sheet">
      <h2><span class="dot" style="background:${ac(id)};width:12px;height:12px;border-radius:50%"></span>${l.name}</h2>
      <div class="hint">${typeLabel} · ${ratePct}${l.payDay?` · due ${ord(l.payDay)} of each month`:''}</div>
      <div class="chartwrap">${drawChart(actual,projected,id)}
        <div class="legend">
          <span style="color:${ac(id)}"><i></i> Actual</span>
          <span style="color:${ac(id)}"><i class="dash"></i> Projected</span>
        </div></div>
      <div class="dstat">
        <div><div class="k">Balance</div><div class="v mono">${fmt(l.bal)}</div></div>
        <div><div class="k">Paid off</div><div class="v mono">${pct}%</div></div>
        <div><div class="k">Original</div><div class="v mono">${fmtShort(l.orig)}</div></div>
        <div><div class="k">Interest paid</div><div class="v mono">${fmtShort(intPaid)}</div></div>
        <div><div class="k">Payments made</div><div class="v mono">${paysMade}</div></div>
        <div><div class="k">Gone by</div><div class="v mono">${gone}</div></div></div>
      <div class="btnrow"><button class="primary" id="closeDetail">Close</button></div></div>`;
    scrim.innerHTML = h; scrim.classList.add('open');
    document.getElementById('closeDetail').onclick = closeSheet;
  }

  // ── Budget history sheet ──────────────────────────────────────────────────
  function openBudget() {
    let h = `<div class="sheet"><h2>Budget history</h2>
      <div class="hint">Monthly living spending vs your ${fmt(S.expenses)} target.</div>`;
    const spends = [];
    for (let k=0; k<S.cursor; k++) { const e=S.history[k]; if(e&&typeof e.spend==='number') spends.push({month:e.month,spend:e.spend}); }
    if (!spends.length) {
      h += `<div class="empty">No months logged yet. Use "Log this month" to start tracking.</div>`;
    } else {
      const avg = spends.reduce((s,x)=>s+x.spend,0)/spends.length;
      h += `<div class="dstat" style="margin-top:0">
        <div><div class="k">Average spent</div><div class="v mono">${fmt(avg)}</div></div>
        <div><div class="k">Target</div><div class="v mono">${fmt(S.expenses)}</div></div></div>`;
      spends.slice().reverse().forEach(x => {
        const over=x.spend>S.expenses, diff=Math.abs(x.spend-S.expenses);
        h += `<div class="histrow"><span class="mlab">${x.month}</span>
          <span style="display:flex;align-items:center;gap:9px">
            <span class="mono">${fmt(x.spend)}</span>
            <span class="pill" style="background:${over?'#FBE9E7':'#E7F4EF'};color:${over?'var(--danger)':'var(--emerald)'}">${over?'+':'−'}${fmtShort(diff)}</span>
          </span></div>`;
      });
    }
    h += `<div class="btnrow"><button class="primary" id="closeBudget">Close</button></div></div>`;
    scrim.innerHTML = h; scrim.classList.add('open');
    document.getElementById('closeBudget').onclick = closeSheet;
  }

  // ── Log month sheet ───────────────────────────────────────────────────────
  function openLog() {
    const plan     = plannedFor(clone(S.loans), S.income, S.expenses);
    const curMonth = monthLabel(S.startAbs+S.cursor);
    let h = `<div class="sheet"><h2>Log ${curMonth}</h2>
      <div class="hint">Enter what you actually paid on each loan, and your total living spending this month.</div>`;
    let hasActive = false;
    for (const id of S.order) {
      const l = S.loans[id]; if (!l||l.bal<=0.5) continue;
      hasActive = true;
      const planned = Math.round(plan[id]||0), interest = Math.round(l.bal*l.rate);
      h += `<div class="field" style="--ac:${ac(id)}">
        <div class="flabel">
          <div class="fn"><span class="dot" style="background:${ac(id)}"></span>${l.name}${l.payDay?` <span style="font-size:10px;color:var(--faint);font-weight:400">due ${ord(l.payDay)}</span>`:''}</div>
          <div class="fmeta mono">bal ${fmt(l.bal)}</div></div>
        <input id="in_${id}" inputmode="numeric" value="${planned.toLocaleString('en-US')}">
        <div class="quick">
          <span class="chip" data-set="${id}" data-v="${planned}">Planned ${fmtShort(planned)}</span>
          <span class="chip" data-set="${id}" data-v="${interest}">Interest only ${fmtShort(interest)}</span>
          <span class="chip" data-set="${id}" data-v="0">Skip (₮0)</span></div>
        <div class="fmeta mono" style="margin-top:5px">interest this month: ${fmt(interest)}</div></div>`;
    }
    if (!hasActive) h += `<div class="empty">All loans are paid off!</div>`;
    h += `<div class="field" style="--ac:var(--indigo)">
      <div class="flabel">
        <div class="fn"><span class="dot" style="background:var(--indigo)"></span>Living spending</div>
        <div class="fmeta mono">target ${fmt(S.expenses)}</div></div>
      <input id="in_spend" inputmode="numeric" value="${S.expenses.toLocaleString('en-US')}">
      <div class="quick">
        <span class="chip" data-set="spend" data-v="${S.expenses}">On target ${fmtShort(S.expenses)}</span>
        <span class="chip" data-set="spend" data-v="${Math.round(S.expenses*0.8)}">Under ${fmtShort(Math.round(S.expenses*0.8))}</span></div></div>
    <div class="btnrow"><button class="ghost" id="cancelLog">Cancel</button><button class="primary" id="saveLog">Save &amp; advance</button></div></div>`;
    scrim.innerHTML = h; scrim.classList.add('open');
    scrim.querySelectorAll('.chip').forEach(c => c.onclick=()=>{ const el=document.getElementById('in_'+c.dataset.set); if(el) el.value=Number(c.dataset.v).toLocaleString('en-US'); });
    scrim.querySelectorAll('.field input').forEach(inp => {
      inp.onblur  = () => { const n=parseInt(inp.value.replace(/[^\d]/g,''))||0; inp.value=n.toLocaleString('en-US'); };
      inp.onfocus = () => { inp.value=inp.value.replace(/[^\d]/g,''); };
    });
    document.getElementById('cancelLog').onclick = closeSheet;
    document.getElementById('saveLog').onclick = () => {
      const prev={}, pays={};
      for (const id of S.order) {
        const l=S.loans[id]; if(!l){pays[id]=0;continue;}
        prev[id]=l.bal;
        if (l.bal<=0.5){pays[id]=0;continue;}
        const inp=document.getElementById('in_'+id);
        const pay=inp?(parseInt(inp.value.replace(/[^\d]/g,''))||0):0;
        pays[id]=pay; l.bal=Math.max(0,l.bal*(1+l.rate)-pay);
      }
      const sp=document.getElementById('in_spend');
      const spend=sp?(parseInt(sp.value.replace(/[^\d]/g,''))||0):S.expenses;
      S.history.push({month:curMonth,pays,prev,spend});
      S.cursor++; save(S); closeSheet(); render();
    };
  }

  // ── Add loan sheet ────────────────────────────────────────────────────────
  function openAddLoan(fromSettings) {
    let h = `<div class="sheet"><h2>Add loan</h2>
      <div class="hint">You can edit or delete any loan from ⚙ settings.</div>
      <label class="set-label">Loan name</label>
      <input class="set-input" id="nl_name" placeholder="e.g. Car loan, Credit card, Mortgage" autocomplete="off">
      <div class="two">
        <div><label class="set-label">Current balance</label>
          <input class="set-input mono" id="nl_bal" placeholder="0" inputmode="numeric"></div>
        <div><label class="set-label">Interest rate %/mo</label>
          <input class="set-input mono" id="nl_rate" placeholder="1.5" inputmode="decimal"></div>
      </div>
      <label class="set-label">Loan type</label>
      <select class="set-input" id="nl_type">
        <option value="fixed">Fixed payment — installment (car, mortgage…)</option>
        <option value="revolving">Revolving — credit / BNPL (10% balance + interest/mo)</option>
      </select>
      <div id="nl_plan_row">
        <label class="set-label">Monthly payment amount</label>
        <input class="set-input mono" id="nl_plan" placeholder="0" inputmode="numeric">
      </div>
      <label class="set-label">Payment due day of month (optional)</label>
      <input class="set-input mono" id="nl_day" placeholder="e.g. 25" inputmode="numeric" maxlength="2" style="width:120px">
      <div class="btnrow">
        <button class="ghost" id="nl_cancel">Cancel</button>
        <button class="primary" id="nl_save">Add loan</button>
      </div></div>`;
    scrim.innerHTML = h; scrim.classList.add('open');
    document.getElementById('nl_type').onchange = e => {
      document.getElementById('nl_plan_row').style.display = e.target.value==='revolving'?'none':'';
    };
    document.getElementById('nl_cancel').onclick = () => { closeSheet(); if(fromSettings) openSettings(); };
    document.getElementById('nl_save').onclick = () => {
      const name = (document.getElementById('nl_name').value||'').trim();
      if (!name) { alert('Please enter a loan name.'); return; }
      const bal   = parseInt((document.getElementById('nl_bal').value||'').replace(/[^\d]/g,''))||0;
      const rate  = parseFloat(document.getElementById('nl_rate').value)||0;
      const type  = document.getElementById('nl_type').value;
      const plan  = type==='fixed'?(parseInt((document.getElementById('nl_plan').value||'').replace(/[^\d]/g,''))||0):0;
      const dayRaw = parseInt(document.getElementById('nl_day').value)||0;
      const payDay = dayRaw>=1&&dayRaw<=31 ? dayRaw : null;
      const id = 'loan_'+Date.now();
      S.loans[id] = { name, bal, orig:bal, rate:rate/100, type, plan, payDay, color:PALETTE[S.order.length%PALETTE.length] };
      S.order.push(id);
      save(S); closeSheet();
      if (fromSettings) openSettings(); else render();
    };
  }

  // ── Settings sheet ────────────────────────────────────────────────────────
  function openSettings() {
    const gpct = v => { const f=parseFloat(String(v).replace(/[^\d.]/g,'')); return isNaN(f)?0:f; };
    let h = `<div class="sheet"><h2>Settings</h2>`;

    // Signed-in user card
    if (currentUser) {
      h += `<div class="user-bar">
        ${currentUser.photoURL?`<img src="${currentUser.photoURL}" alt="">`:'<div style="width:36px;height:36px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px">👤</div>'}
        <div class="info">
          <div class="name">${currentUser.displayName||'Signed in'}</div>
          <div class="email">${currentUser.email}</div>
        </div>
        <button class="ghost" id="signOutBtn" style="flex:0 0 auto;padding:7px 12px;font-size:12px;border-radius:10px;box-shadow:none">Sign out</button>
      </div>`;
    }

    h += `<div class="hint" style="margin-top:0">Income and budget determine how surplus cash flows to your loans.</div>
      <div class="two">
        <div><label class="set-label">Monthly income</label>
          <input class="set-input mono" id="s_income" value="${S.income?S.income.toLocaleString('en-US'):''}" placeholder="4,732,000" inputmode="numeric"></div>
        <div><label class="set-label">Monthly living budget</label>
          <input class="set-input mono" id="s_expenses" value="${S.expenses?S.expenses.toLocaleString('en-US'):''}" placeholder="1,500,000" inputmode="numeric"></div>
      </div>
      <div class="divider"></div>
      <div class="row-space" style="margin-bottom:10px">
        <span style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:15px">Loans (${S.order.length})</span>
        <button class="ghost" id="addLoanBtn" style="flex:0 0 auto;padding:8px 14px;font-size:12px;border-radius:10px">＋ Add loan</button>
      </div>`;

    if (S.order.length === 0) {
      h += `<div class="empty">No loans yet — tap "+ Add loan" above.</div>`;
    }
    for (const id of S.order) {
      const l = S.loans[id]; if (!l) continue;
      h += `<div class="scard" style="--ac:${ac(id)}">
        <div class="sh">
          <span class="dot" style="background:${ac(id)}"></span>
          <input class="set-input" id="s_name_${id}" value="${l.name}" style="margin:0;flex:1;font-family:'Bricolage Grotesque',sans-serif;font-weight:700;padding:6px 8px;font-size:14px">
          <button data-del="${id}" style="background:none;border:none;color:var(--danger);font-size:16px;padding:4px 8px;cursor:pointer;flex-shrink:0">✕</button>
        </div>
        <div class="two">
          <div><label class="set-label">Current balance</label>
            <input class="set-input mono" id="s_bal_${id}" value="${l.bal?Math.round(l.bal).toLocaleString('en-US'):''}" placeholder="0" inputmode="numeric"></div>
          <div><label class="set-label">Rate %/mo</label>
            <input class="set-input mono" id="s_rate_${id}" value="${l.rate?(l.rate*100).toString():''}" placeholder="1.5" inputmode="decimal"></div>
        </div>
        <div class="two">
          <div>
            ${l.type==='fixed'
              ? `<label class="set-label">Monthly payment</label>
                 <input class="set-input mono" id="s_plan_${id}" value="${l.plan?Math.round(l.plan).toLocaleString('en-US'):''}" placeholder="0" inputmode="numeric">`
              : `<label class="set-label">Type</label>
                 <div class="set-input" style="background:var(--paper);color:var(--soft);font-size:12px;cursor:default">Revolving (10% min)</div>`}
          </div>
          <div><label class="set-label">Due day</label>
            <input class="set-input mono" id="s_day_${id}" value="${l.payDay||''}" placeholder="e.g. 25" inputmode="numeric" maxlength="2"></div>
        </div>
      </div>`;
    }

    h += `<div class="divider"></div>
      <div style="font-size:12px;color:var(--soft)">Export saves all data as a JSON file — use it to migrate to another account.</div>
      <div class="btnrow" style="margin-top:8px">
        <button class="ghost" id="exportBtn">⬇ Export JSON</button>
        <button class="ghost" id="importBtn">⬆ Import JSON</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" style="display:none">
      <div class="btnrow">
        <button class="ghost" id="resetBtn" style="color:var(--danger)">Reset all</button>
        <button class="primary" id="saveSet">Save</button>
      </div></div>`;

    scrim.innerHTML = h; scrim.classList.add('open');

    if (currentUser && document.getElementById('signOutBtn')) {
      document.getElementById('signOutBtn').onclick = doSignOut;
    }

    scrim.querySelectorAll('.set-input.mono').forEach(inp => {
      if (!inp.id || inp.id.match(/rate|_day/)) return;
      inp.onblur = () => { const raw=inp.value.replace(/[^\d]/g,''); inp.value=raw?parseInt(raw).toLocaleString('en-US'):''; };
    });

    document.getElementById('addLoanBtn').onclick = () => {
      const g = id => parseInt((document.getElementById(id).value||'').replace(/[^\d]/g,''))||0;
      S.income=g('s_income'); S.expenses=g('s_expenses'); save(S);
      closeSheet(); openAddLoan(true);
    };

    scrim.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => {
        const id=btn.dataset.del; if(!S.loans[id])return;
        if (confirm(`Delete "${S.loans[id].name}"? This cannot be undone.`)) {
          S.order=S.order.filter(x=>x!==id); delete S.loans[id];
          save(S); closeSheet(); openSettings();
        }
      };
    });

    const g = id => parseInt((document.getElementById(id).value||'').replace(/[^\d]/g,''))||0;
    document.getElementById('saveSet').onclick = () => {
      S.income=g('s_income'); S.expenses=g('s_expenses');
      for (const id of S.order) {
        const l=S.loans[id]; if(!l) continue;
        const nm=(document.getElementById('s_name_'+id).value||'').trim(); if(nm)l.name=nm;
        const nb=g('s_bal_'+id); l.bal=nb; if(nb>l.orig)l.orig=nb;
        const rt=gpct(document.getElementById('s_rate_'+id).value); if(rt>0)l.rate=rt/100;
        if(l.type==='fixed'){const el=document.getElementById('s_plan_'+id);if(el)l.plan=g('s_plan_'+id);}
        const de=document.getElementById('s_day_'+id);
        if(de){const d=parseInt(de.value)||0; l.payDay=(d>=1&&d<=31)?d:null;}
      }
      lastDate=null; save(S); closeSheet(); render();
    };
    document.getElementById('exportBtn').onclick = exportData;
    document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
    document.getElementById('importFile').onchange = e => { if(e.target.files[0]) importData(e.target.files[0]); };
    document.getElementById('resetBtn').onclick = () => {
      if (confirm('Erase everything and start over?')) { S=defaults(); lastDate=null; save(S); closeSheet(); render(); }
    };
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function undo() {
    if (!S.history.length) return;
    const last=S.history.pop();
    for (const id in last.prev) { if(S.loans[id]) S.loans[id].bal=last.prev[id]; }
    S.cursor=Math.max(0,S.cursor-1); lastDate=null; save(S); render();
  }

  function exportData() {
    try {
      const blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url; a.download='payoff-backup-'+new Date().toISOString().slice(0,10)+'.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
    } catch(e) { alert('Export failed. Open the hosted URL in Safari to export.'); }
  }
  function importData(file) {
    const r=new FileReader();
    r.onload = () => {
      try {
        const obj=JSON.parse(r.result);
        if(obj&&obj.loans&&obj.order&&typeof obj.cursor==='number'){
          S=migrate(obj); lastDate=null; save(S); closeSheet(); render();
        } else alert('That file does not look like a valid backup.');
      } catch(e) { alert('Could not read that file.'); }
    };
    r.readAsText(file);
  }

  function closeSheet() { scrim.classList.remove('open'); scrim.innerHTML=''; }
  scrim.onclick = e => { if(e.target===scrim) closeSheet(); };

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (!configured) {
    renderLogin();
  } else {
    // Show loading while Firebase decides auth state
    appEl.innerHTML = `<div style="text-align:center;padding:80px 0;color:var(--faint);font-size:13px">Loading…</div>`;
    auth.onAuthStateChanged(async user => {
      currentUser = user;
      if (!user) { renderLogin(); return; }
      const saved = migrate(await load());
      if (saved && saved.loans) S = saved;
      render();
    });
  }
})();
