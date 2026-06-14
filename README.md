# Fin Plan

Personal finance tracker — loan payoff planning + monthly spending. PWA, works offline, syncs via Firebase.

## Pending setup (one-time)

- [ ] Firestore → Rules → apply the security rules below
- [ ] Firebase Console → Authentication → Settings → Authorized domains → add `fin-plan-59c19.web.app`
- [ ] Fix GitHub Actions deployment (service account needs Firebase Hosting Admin role in Google Cloud IAM)

### Firestore security rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

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
