// Static configuration shared across the app. No app state, no DOM — safe to
// import from anywhere without creating cycles.

export const DEFAULT_CATEGORIES = [
  { id: 'food',      label: 'Food',      icon: '🍔', color: '#C2410C' },
  { id: 'transport', label: 'Transport', icon: '🚌', color: '#0369A1' },
  { id: 'shopping',  label: 'Shopping',  icon: '🛍', color: '#7C3AED' },
  { id: 'bills',     label: 'Bills',     icon: '⚡', color: '#B45309' },
  { id: 'health',    label: 'Health',    icon: '💊', color: '#147A5C' },
  { id: 'fun',       label: 'Fun',       icon: '🎬', color: '#BE185D' },
  { id: 'housing',   label: 'Housing',   icon: '🏠', color: '#2B2D77' },
  { id: 'other',     label: 'Other',     icon: '✦',  color: '#566072' },
];
// The "other" bucket every unknown/deleted category falls back to.
export const OTHER_CAT = DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1];

export const PALETTE = ['#C2410C', '#147A5C', '#2B2D77', '#566072', '#7C3AED', '#B45309', '#0369A1', '#BE185D'];

// Account kinds (liquid money the user holds). Balance can be negative for an
// overdrawn account; debt is still tracked separately as loans.
export const ACCOUNT_TYPES = [
  { id: 'bank',   label: 'Bank',       icon: '🏦' },
  { id: 'cash',   label: 'Cash',       icon: '💵' },
  { id: 'wallet', label: 'E-wallet',   icon: '📱' },
  { id: 'invest', label: 'Investment', icon: '📈' },
];
export const ACCOUNT_TYPE_MAP = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.id, t]));

// Absolute month index basis (see monthLabel / nowAbs in state.js).
export const BASE = 2026 * 12 + 5;

// Supported display currencies. Amounts are stored as plain numbers; only the
// symbol shown differs (no FX conversion — this picks how money is rendered).
export const CURRENCIES = [
  { code: 'MNT', symbol: '₮' }, { code: 'USD', symbol: '$' }, { code: 'EUR', symbol: '€' },
  { code: 'GBP', symbol: '£' }, { code: 'JPY', symbol: '¥' }, { code: 'CNY', symbol: '¥' },
  { code: 'KRW', symbol: '₩' }, { code: 'INR', symbol: '₹' }, { code: 'RUB', symbol: '₽' },
  { code: 'CAD', symbol: 'C$' }, { code: 'AUD', symbol: 'A$' }, { code: 'SGD', symbol: 'S$' },
];

export const KEY = 'finplan_v2';
export const UIDKEY = 'finplan_uid';
export const THEMEKEY = 'finplan_theme';
export const SCHEMA = 2;
export const APP_VERSION = '0.2.3';

// Escape any user-supplied string before it enters an innerHTML template or an
// HTML attribute value. Prevents XSS / attribute-breakout from loan names,
// goal names, spend notes, category labels and profile fields.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
