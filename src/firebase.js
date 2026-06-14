import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

// Firebase web config is public by design — it ships to every client and is
// not a secret. Access is controlled by Firestore security rules + Auth.
const firebaseConfig = {
  apiKey: 'AIzaSyAJ4Y_9VE23DJ0CuQyJhjbQH-iLeo1mztc',
  authDomain: 'fin-plan-59c19.firebaseapp.com',
  projectId: 'fin-plan-59c19',
  storageBucket: 'fin-plan-59c19.firebasestorage.app',
  messagingSenderId: '21809874373',
  appId: '1:21809874373:web:e108c2cad46caa68a237ac',
};

export const configured = firebaseConfig.apiKey !== 'REPLACE_ME';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Keep the user signed in across reloads (default, but explicit).
setPersistence(auth, browserLocalPersistence).catch(() => {});

export const provider = new GoogleAuthProvider();

// Modern offline cache (replaces the deprecated enableMultiTabIndexedDbPersistence).
// Multi-tab safe; no deprecation warning.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
