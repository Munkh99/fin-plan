import { describe, it, expect } from 'vitest';
import {
  cloneLoans,
  plannedLoans,
  totalSavingsContrib,
  freeCash,
  simulateLoans,
  savMonthsToGoal,
  payoffMonths,
} from './finance.js';

const base = () => ({
  income: 0, budget: 0,
  loans: {}, loanOrder: [],
  savings: {}, savingsOrder: [],
  startAbs: 0, cursor: 0,
});

describe('plannedLoans', () => {
  it('fixed loan pays its plan amount', () => {
    const S = { ...base(), loans: { a: { bal: 1000, rate: 0.01, type: 'fixed', plan: 200 } }, loanOrder: ['a'] };
    expect(plannedLoans(S).a).toBe(200);
  });

  it('fixed loan plan is capped at full payoff (balance + interest)', () => {
    const S = { ...base(), loans: { a: { bal: 100, rate: 0.01, type: 'fixed', plan: 500 } }, loanOrder: ['a'] };
    expect(plannedLoans(S).a).toBeCloseTo(101); // 100 * 1.01
  });

  it('paid-off loan plans 0', () => {
    const S = { ...base(), loans: { a: { bal: 0, rate: 0.01, type: 'fixed', plan: 200 } }, loanOrder: ['a'] };
    expect(plannedLoans(S).a).toBe(0);
  });

  it('revolving loan gets minimum (interest + 10%) plus all surplus on the first', () => {
    // min = 1000*0.02 + 1000*0.10 = 120; surplus = 1000 - 0 - 120 = 880; first = 120+880 = 1000 (< payoff 1020)
    const S = { ...base(), income: 1000, loans: { a: { bal: 1000, rate: 0.02, type: 'revolving' } }, loanOrder: ['a'] };
    expect(plannedLoans(S).a).toBe(1000);
  });

  it('second revolving loan only gets its minimum (avalanche on first)', () => {
    const S = {
      ...base(), income: 5000,
      loans: { a: { bal: 1000, rate: 0.02, type: 'revolving' }, b: { bal: 2000, rate: 0.03, type: 'revolving' } },
      loanOrder: ['a', 'b'],
    };
    const p = plannedLoans(S);
    expect(p.b).toBeCloseTo(2000 * 0.03 + 2000 * 0.10); // b gets only its minimum
  });

  it('does not mutate the passed state', () => {
    const S = { ...base(), loans: { a: { bal: 1000, rate: 0.01, type: 'fixed', plan: 200 } }, loanOrder: ['a'] };
    plannedLoans(S);
    expect(S.loans.a.bal).toBe(1000);
  });
});

describe('totalSavingsContrib', () => {
  it('sums monthly only for goals not yet reached', () => {
    const S = {
      ...base(),
      savings: { a: { current: 0, target: 100, monthly: 50 }, b: { current: 100, target: 100, monthly: 30 } },
      savingsOrder: ['a', 'b'],
    };
    expect(totalSavingsContrib(S)).toBe(50);
  });
});

describe('freeCash', () => {
  it('income minus budget minus planned loans minus savings', () => {
    const S = {
      ...base(), income: 2000, budget: 500,
      loans: { a: { bal: 1000, rate: 0.01, type: 'fixed', plan: 300 } }, loanOrder: ['a'],
      savings: { s: { current: 0, target: 1000, monthly: 200 } }, savingsOrder: ['s'],
    };
    expect(freeCash(S)).toBe(2000 - 500 - 300 - 200); // 1000
  });

  it('can go negative when over-committed', () => {
    const S = { ...base(), income: 100, budget: 200 };
    expect(freeCash(S)).toBe(-100);
  });
});

describe('savMonthsToGoal', () => {
  it('rounds up remaining / monthly', () => {
    const S = { ...base(), savings: { a: { current: 100, target: 1000, monthly: 300 } }, savingsOrder: ['a'] };
    expect(savMonthsToGoal(S, 'a')).toBe(3); // ceil(900/300)
  });
  it('returns 0 once the goal is reached', () => {
    const S = { ...base(), savings: { a: { current: 1000, target: 1000, monthly: 300 } } };
    expect(savMonthsToGoal(S, 'a')).toBe(0);
  });
  it('returns null when there is no monthly contribution', () => {
    const S = { ...base(), savings: { a: { current: 0, target: 1000, monthly: 0 } } };
    expect(savMonthsToGoal(S, 'a')).toBe(null);
  });
  it('interest reaches the goal no later than contributions alone', () => {
    const plain = { ...base(), savings: { a: { current: 0, target: 1000, monthly: 100 } }, savingsOrder: ['a'] };
    const withRate = { ...base(), savings: { a: { current: 0, target: 1000, monthly: 100, rate: 0.12 } }, savingsOrder: ['a'] };
    expect(savMonthsToGoal(withRate, 'a')).toBeLessThanOrEqual(savMonthsToGoal(plain, 'a'));
  });
  it('interest alone (no monthly) still reaches the goal when there is a balance', () => {
    const S = { ...base(), savings: { a: { current: 900, target: 1000, monthly: 0, rate: 0.12 } }, savingsOrder: ['a'] };
    const m = savMonthsToGoal(S, 'a');
    expect(m).toBeGreaterThan(0);
    expect(Number.isFinite(m)).toBe(true);
  });
});

describe('payoffMonths', () => {
  it('zero-interest: balance / payment rounded up', () => {
    expect(payoffMonths(1000, 0, 250)).toBe(4);
    expect(payoffMonths(1000, 0, 300)).toBe(4); // ceil(3.33)
  });
  it('already paid off', () => {
    expect(payoffMonths(0, 0.01, 100)).toBe(0);
  });
  it('returns Infinity when the payment never beats the interest', () => {
    expect(payoffMonths(1000, 0.02, 20)).toBe(Infinity); // 20 == interest
    expect(payoffMonths(1000, 0.02, 10)).toBe(Infinity);
  });
  it('a bigger payment pays off sooner', () => {
    expect(payoffMonths(1000, 0.01, 200)).toBeLessThan(payoffMonths(1000, 0.01, 100));
  });
});

describe('simulateLoans', () => {
  it('pays off a zero-interest fixed loan in the expected number of months', () => {
    const S = { ...base(), loans: { a: { bal: 1000, rate: 0, type: 'fixed', plan: 250 } }, loanOrder: ['a'] };
    expect(simulateLoans(S).months).toBe(4); // 1000 / 250
  });

  it('does not loop forever when a fixed loan has no payment plan', () => {
    const S = { ...base(), loans: { a: { bal: 1000, rate: 0.01, type: 'fixed', plan: 0 } }, loanOrder: ['a'] };
    expect(simulateLoans(S).months).toBe(0);
  });

  it('accrues interest into totalInt', () => {
    const S = { ...base(), loans: { a: { bal: 1000, rate: 0.05, type: 'fixed', plan: 600 } }, loanOrder: ['a'] };
    const r = simulateLoans(S);
    expect(r.totalInt).toBeGreaterThan(0);
    expect(r.months).toBe(2); // 1000*1.05-600=450; 450*1.05-600<=0
  });

  it('payoffAbs reflects the starting month plus duration', () => {
    const S = { ...base(), startAbs: 10, cursor: 2, loans: { a: { bal: 500, rate: 0, type: 'fixed', plan: 500 } }, loanOrder: ['a'] };
    const r = simulateLoans(S);
    expect(r.months).toBe(1);
    expect(r.payoffAbs).toBe(12); // startAbs + cursor + max(0, months-1)
  });
});
