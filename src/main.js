// Entry point: loads styles, wires the store's UI callbacks, and runs the
// optimistic boot + Firebase auth lifecycle. All feature logic lives in the
// layered modules: constants → state → store → (dom → views/sheets).

import './style.css';
import { auth, configured } from './firebase.js';
import { onAuthStateChanged } from 'firebase/auth';
import { KEY, UIDKEY } from './constants.js';
import { setS, defaults, migrate, loadLocal } from './state.js';
import {
  setCurrentUser, setReconcile, setSyncDot,
  detachListeners, attachListeners, prepareRemote,
} from './store.js';
import { appEl, V, closeSheet } from './dom.js';
import { go, renderView, reconcile, updateSyncDot } from './views.js';
import { renderLogin } from './sheets.js';

// Wire the store's UI hooks once, so store.js never imports the view layer.
setReconcile(reconcile);
setSyncDot(updateSyncDot);

if (!configured) {
  renderLogin();
} else {
  const cachedUid = (() => { try { return localStorage.getItem(UIDKEY); } catch (e) { return null; } })();

  // Optimistic: if this device was signed in before, render instantly from the
  // local cache without waiting for the auth/network round-trip.
  if (cachedUid) {
    const saved = migrate(loadLocal());
    if (saved) setS(saved);
    renderView(); // believe the cached session; auth confirms below
  } else {
    appEl.innerHTML = `<div style="text-align:center;padding:80px 0;color:var(--faint);font-size:13px">Loading…</div>`;
  }

  onAuthStateChanged(auth, async (user) => {
    setCurrentUser(user);
    if (!user) {
      detachListeners();
      closeSheet();
      try { localStorage.removeItem(UIDKEY); } catch (e) {}
      V.view = 'login'; V.booted = false; renderLogin();
      return;
    }
    try { localStorage.setItem(UIDKEY, user.uid); } catch (e) {}
    // Different account on this device → drop the previous user's cached data.
    if (cachedUid && cachedUid !== user.uid) {
      try { localStorage.removeItem(KEY); } catch (e) {}
      setS(defaults()); V.booted = false;
    }
    // Render immediately from cache — never block on the network.
    if (!V.booted) go();
    // Reconcile cloud state (migrate legacy / seed empty cloud) BEFORE attaching
    // listeners, so empty-collection snapshots can't wipe local-only data. The UI
    // is already visible above, so even if this is slow nothing blocks.
    await prepareRemote();
    attachListeners();
  });
}
