// Pure finance engine — no DOM, no Firebase, no global state.
// Every function takes the state object `S` explicitly so it can be unit-tested.
// See finance.test.js.

export function cloneLoans(S) {
  const L = {};
  for (const k in S.loans) L[k] = { ...S.loans[k] };
  return L;
}

// How much to pay each loan this month given the cash-flow plan:
//  - fixed loans pay their set plan (capped at full payoff)
//  - revolving loans pay at least (interest + 10% of balance); any leftover
//    surplus (income − budget − fixed − minimums) is thrown at the first one.
export function plannedLoans(S, L = cloneLoans(S)) {
  const out = {};
  for (const id of S.loanOrder) {
    const l = L[id];
    if (!l || l.bal <= 0.5) { out[id] = 0; continue; }
    if (l.type === 'fixed') out[id] = Math.min(l.plan, l.bal * (1 + l.rate));
  }
  const rev = S.loanOrder.filter((id) => L[id] && L[id].bal > 0.5 && L[id].type === 'revolving');
  const mins = {};
  for (const id of rev) { const l = L[id]; mins[id] = l.bal * l.rate + l.bal * 0.10; }
  const fixedSum = S.loanOrder.reduce((s, id) => (out[id] || 0) + s, 0);
  const minSum = rev.reduce((s, id) => mins[id] + s, 0);
  const surplus = Math.max(0, (S.income - S.budget) - fixedSum - minSum);
  for (let i = 0; i < rev.length; i++) {
    const id = rev[i], l = L[id];
    out[id] = Math.min(l.bal * (1 + l.rate), i === 0 ? mins[id] + surplus : mins[id]);
  }
  return out;
}

export function totalSavingsContrib(S) {
  return S.savingsOrder.reduce((s, id) => {
    const sv = S.savings[id];
    return (!sv || sv.current >= sv.target) ? s : s + sv.monthly;
  }, 0);
}

// Money left after the budget, planned loan payments and savings contributions.
export function freeCash(S) {
  const lp = plannedLoans(S, cloneLoans(S));
  return S.income - S.budget - S.loanOrder.reduce((s, id) => s + (lp[id] || 0), 0) - totalSavingsContrib(S);
}

// Project balances forward month by month until everything is paid off.
export function simulateLoans(S) {
  const L = cloneLoans(S);
  const snaps = [];
  let guard = 0, abs = S.startAbs + S.cursor, totalInt = 0;
  const any = () => S.loanOrder.some((id) => L[id] && L[id].bal > 0.5);
  const hasPlan = () => S.loanOrder.some((id) => {
    const l = L[id];
    if (!l || l.bal <= 0.5) return false;
    return l.type === 'revolving' || (l.type === 'fixed' && l.plan > 0);
  });
  while (any() && guard < 1200 && hasPlan()) {
    snaps.push({ abs, bals: Object.fromEntries(S.loanOrder.map((id) => [id, L[id] ? L[id].bal : 0])) });
    const plan = plannedLoans(S, L);
    if (S.loanOrder.reduce((s, id) => s + (plan[id] || 0), 0) <= 0) break;
    for (const id of S.loanOrder) {
      const l = L[id];
      if (!l || l.bal <= 0.5) { if (l) l.bal = 0; continue; }
      totalInt += l.bal * l.rate;
      l.bal = Math.max(0, l.bal * (1 + l.rate) - (plan[id] || 0));
    }
    abs++; guard++;
  }
  snaps.push({ abs, bals: Object.fromEntries(S.loanOrder.map((id) => [id, L[id] ? Math.max(0, L[id].bal) : 0])) });
  return { snaps, months: guard, totalInt, payoffAbs: S.startAbs + S.cursor + Math.max(0, guard - 1) };
}

export function savMonthsToGoal(S, id) {
  const sv = S.savings[id];
  if (!sv) return null;
  const rem = sv.target - sv.current;
  if (rem <= 0) return 0;
  if (sv.monthly <= 0) return null;
  return Math.ceil(rem / sv.monthly);
}
