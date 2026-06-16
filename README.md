# Fin Plan

Personal finance tracker — spending, accounts, loan-payoff planning and savings goals. Vanilla-JS PWA, works offline, syncs per-user via Firebase.

## Develop
```
npm install
npm run dev      # local dev server
npm test         # unit tests (finance engine)
npm run build    # production build
```

## Deploy

**Automatic:** push to `main` → GitHub Actions deploys to Firebase Hosting (needs the `FIREBASE_SERVICE_ACCOUNT` repo secret).

**Manual (from your machine):**
```
npm install -g firebase-tools   # one-time: install the CLI
firebase login                  # one-time: sign in as the project owner
npm run deploy                  # build, then deploy hosting + firestore rules
```
`npm run deploy` runs `vite build && firebase deploy` — the build is required, since `firebase deploy` only uploads what's in `dist/`. Scope it with `firebase deploy --only hosting` or `--only firestore:rules` if needed.

One-time Firebase setup: add the hosting domain under Auth → Settings → Authorized domains.

## Security
[`firestore.rules`](firestore.rules) scopes every read/write to the signed-in user's own `/users/{uid}` tree, including all subcollections via the recursive `/{document=**}` match. Don't shorten it — that would leave subcollections unprotected.

## Architecture
Layered ES modules under `src/` (dependencies flow downward; the core is acyclic):
- `constants.js` — static config (categories, currencies, account types). No deps.
- `state.js` — the source of truth `S` plus pure selectors/formatters.
- `store.js` — Firestore persistence + real-time listeners; talks to the UI only via injected callbacks, so it never imports the view layer.
- `dom.js` — root elements, dialogs/toast, theme, shared UI state `V`.
- `views.js` — read-only renderers (shell, tabs, charts).
- `sheets.js` — interactive modals (forms, detail, settings, managers, onboarding, login).
- `main.js` — entry point: wires store callbacks + runs the boot/auth lifecycle.
- `finance.js` — pure loan/savings math (unit-tested in `finance.test.js`).

## Stack
Vanilla JS · Vite · Firebase Auth (Google) + Firestore (offline via IndexedDB) · PWA (auto-updating) · Firebase Hosting.

## Forking
Put your own Firebase project credentials in `src/firebase.js` and `.firebaserc`.
