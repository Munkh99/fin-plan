# Fin Plan

Personal finance tracker — loan payoff planning + monthly spending. PWA, works offline, syncs via Firebase.

## Pending setup (one-time)

- [ ] Deploy the security rules: `firebase deploy --only firestore:rules` (the canonical rules live in [`firestore.rules`](firestore.rules) and are wired into `firebase.json`)
- [ ] Firebase Console → Authentication → Settings → Authorized domains → add `fin-plan-59c19.web.app`
- [ ] Fix GitHub Actions deployment (service account needs Firebase Hosting Admin role in Google Cloud IAM)

### Firestore security rules

The authoritative rules are in [`firestore.rules`](firestore.rules). They scope every read/write to
the signed-in user's own `/users/{uid}` tree **including all subcollections** (loans, savings,
spends) via the `/{document=**}` recursive match — don't paste a shorter version here, it would
leave the subcollections unprotected.

## Deploy
Push to `main` — GitHub Actions deploys to Firebase Hosting automatically.
Requires `FIREBASE_SERVICE_ACCOUNT` secret in GitHub repo settings.

## Local dev
Open `index.html` directly in a browser (no build step needed).

## Stack
- Vanilla JS, no framework
- Firebase Auth (Google Sign-In)
- Firebase Firestore (cloud sync + offline via IndexedDB)
- PWA (installable on iPhone via Safari "Add to Home Screen")
- Firebase Hosting via GitHub Actions

## Forking
Update `config.js` and `.firebaserc` with your own Firebase project credentials.
