import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useDeferredValue,
  Component,
  memo,
} from 'react';
import {
  Search, Bookmark, Bell, ExternalLink, Sparkles, Filter,
  Gamepad2, X, Star, Zap, LogOut, User as UserIcon,
  Loader2, AlertCircle, Trash2,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════
   1. CONFIG
   ═══════════════════════════════════════════════════════════ */

const FB_CFG = {
  apiKey: import.meta.env?.VITE_FB_API_KEY || '',
  authDomain: import.meta.env?.VITE_FB_AUTH_DOMAIN || '',
  projectId: import.meta.env?.VITE_FB_PROJECT_ID || '',
  storageBucket: import.meta.env?.VITE_FB_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env?.VITE_FB_MESSAGING_SENDER_ID || '',
  appId: import.meta.env?.VITE_FB_APP_ID || '',
};

const GEMINI_KEY = import.meta.env?.VITE_GEMINI_API_KEY || '';
const hasGemini = Boolean(GEMINI_KEY);
const firebaseConfigured = Boolean(FB_CFG.apiKey && FB_CFG.projectId);
const APP_ID = FB_CFG.appId || 'local-app';

/* ═══════════════════════════════════════════════════════════
   2. UTILS
   ═══════════════════════════════════════════════════════════ */

const BRL_FMT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});
const formatBRL = (v) => BRL_FMT.format(v);

const CV_STYLE = { contentVisibility: 'auto', containIntrinsicSize: '0 340px' };

const LS_PREFIX = 'xpr:';
const lsKey = (uid) => `${LS_PREFIX}${uid || 'anon'}`;

function loadLocal(uid) {
  try {
    const raw = localStorage.getItem(lsKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLocal(uid, data) {
  try {
    localStorage.setItem(lsKey(uid), JSON.stringify(data));
  } catch (e) {
    console.error('localStorage save falhou:', e);
  }
}

/* ═══════════════════════════════════════════════════════════
   3. FIREBASE — lazy loader
   ═══════════════════════════════════════════════════════════ */

let firebasePromise = null;

function loadFirebase() {
  if (firebasePromise) return firebasePromise;

  firebasePromise = (async () => {
    if (!firebaseConfigured) {
      return { auth: null, db: null, mods: null };
    }
    try {
      const [appMod, authMod, dbMod] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
        import('firebase/firestore'),
      ]);
      const app = appMod.getApps().length
        ? appMod.getApp()
        : appMod.initializeApp(FB_CFG);
      return {
        auth: authMod.getAuth(app),
        db: dbMod.getFirestore(app),
        mods: { auth: authMod, db: dbMod },
      };
    } catch (e) {
      console.error('Falha ao carregar Firebase:', e);
      return { auth: null, db: null, mods: null };
    }
  })();

  return firebasePromise;
}

/* ═══════════════════════════════════════════════════════════
   4. STORAGE
   ═══════════════════════════════════════════════════════════ */

function subscribeUserData(uid, callback) {
  let unsub = () => {};
  let cancelled = false;

  (async () => {
    const { db, mods } = await loadFirebase();
    if (cancelled) return;

    if (db && mods) {
      const { doc, onSnapshot } = mods.db;
      const ref = doc(db, 'artifacts', APP_ID, 'users', uid, 'userData', 'preferences');
      unsub = onSnapshot(
        ref,
        (snap) => {
          if (snap.exists()) callback(snap.data());
        },
        (err) => console.error('Firestore snapshot:', err)
      );
    } else {
      const data = loadLocal(uid);
      if (data) callback(data);

      const handler = (e) => {
        if (e.key === lsKey(uid) && e.newValue) {
          try {
            callback(JSON.parse(e.newValue));
          } catch {}
        }
      };
      window.addEventListener('storage', handler);
      unsub = () => window.removeEventListener('storage', handler);
    }
  })();

  return () => {
    cancelled = true;
    unsub();
  };
}

async function saveUserData(uid, patch) {
  const payload = { ...patch, updatedAt: new Date().toISOString() };
  const { db, mods } = await loadFirebase();

  if (db && mods) {
    const { doc, setDoc } = mods.db;
    const ref = doc(db, 'artifacts', APP_ID, 'users', uid, 'userData', 'preferences');
    await setDoc(ref, payload, { merge: true });
    return;
  }

  const current = loadLocal(uid) || {};
  saveLocal(uid, { ...current, ...payload });
}
