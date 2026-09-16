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
   2. UTILS (constantes fora do componente = zero custo por render)
   ═══════════════════════════════════════════════════════════ */

// Criado UMA vez. Criar Intl.NumberFormat a cada render é caro.
const BRL_FMT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});
const formatBRL = (v) => BRL_FMT.format(v);

// content-visibility: navegador pula renderização de cards fora da tela
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
   3. FIREBASE — lazy loader (não entra no bundle inicial)
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
   4. STORAGE — funciona antes do Firebase carregar
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

/* ═══════════════════════════════════════════════════════════
   5. GEMINI — busca com AbortController
   ═══════════════════════════════════════════════════════════ */

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Você é um comparador de preços de jogos, DLCs e gift cards do Xbox para o Brasil.
O usuário está buscando um título. Pesquise na web e retorne preços atuais em BRL para duas lojas:
1. Eneba (a chave global/regional mais barata, em BRL).
2. Xbox Store Brasil (preço oficial em BRL).
Classifique o item como "game", "subscription" ou "dlc".
Retorne SOMENTE JSON válido neste formato exato (sem markdown, sem comentários):
{
  "title": "string",
  "type": "game" | "subscription" | "dlc",
  "genre": "string",
  "cover": "URL https de uma imagem",
  "prices": {
    "xboxStore": { "price": number, "url": "string" },
    "eneba": { "price": number, "region": "string", "url": "string" }
  }
}`;

function extractJson(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  throw new Error('Resposta do modelo não é JSON válido.');
}

async function searchGamePrice(query, { signal } = {}) {
  if (!GEMINI_KEY) throw new Error('Configure VITE_GEMINI_API_KEY para usar a varredura.');
  if (!query || query.trim().length < 2) throw new Error('Digite ao menos 2 caracteres.');

  const body = {
    contents: [{ parts: [{ text: `Buscar preços atuais para: ${query}` }] }],
    tools: [{ google_search: {} }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { responseMimeType: 'application/json' },
  };

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Resposta vazia do modelo.');

  const data = extractJson(text);

  return {
    title: String(data.title || query),
    type: ['game', 'subscription', 'dlc'].includes(data.type) ? data.type : 'game',
    genre: String(data.genre || 'Outros'),
    cover:
      typeof data.cover === 'string' && data.cover.startsWith('http')
        ? data.cover
        : 'https://picsum.photos/seed/fallback/500/500',
    prices: {
      xboxStore: {
        price: Number(data.prices?.xboxStore?.price) || 0,
        url: data.prices?.xboxStore?.url || 'https://www.xbox.com/pt-BR/games/store',
      },
      eneba: {
        price: Number(data.prices?.eneba?.price) || 0,
        region: data.prices?.eneba?.region || 'Global',
        url: data.prices?.eneba?.url || 'https://www.eneba.com/br/',
      },
    },
  };
}

/* ═══════════════════════════════════════════════════════════
   6. CATÁLOGO — construído UMA vez
   ═══════════════════════════════════════════════════════════ */

const INITIAL_CATALOG = [
  { id: 1, title: 'EA Sports FC 26', cover: 'https://picsum.photos/seed/fc26/500/500', type: 'game', genre: 'Esportes',
    prices: { xboxStore: { price: 299.0, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 119.5, region: 'Argentina / Turquia', url: 'https://www.eneba.com/br/' } } },
  { id: 2, title: 'Grand Theft Auto VI', cover: 'https://picsum.photos/seed/gta6/500/500', type: 'game', genre: 'Ação / Aventura',
    prices: { xboxStore: { price: 349.99, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 199.9, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 3, title: 'Xbox Game Pass Ultimate - 3 Meses (Gift Card)', cover: 'https://picsum.photos/seed/gpu3/500/500', type: 'subscription', genre: 'Assinatura',
    prices: { xboxStore: { price: 149.99, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 92.5, region: 'Turquia / Argentina', url: 'https://www.eneba.com/br/' } } },
  { id: 4, title: 'Xbox Game Pass Ultimate - 12 Meses (Gift Card)', cover: 'https://picsum.photos/seed/gpu12/500/500', type: 'subscription', genre: 'Assinatura',
    prices: { xboxStore: { price: 599.99, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 369.0, region: 'Global / Argentina', url: 'https://www.eneba.com/br/' } } },
  { id: 5, title: 'Cyberpunk 2077', cover: 'https://picsum.photos/seed/cp2077/500/500', type: 'game', genre: 'RPG / Ação',
    prices: { xboxStore: { price: 199.5, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 79.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 501, title: 'Cyberpunk 2077: Phantom Liberty (DLC)', cover: 'https://picsum.photos/seed/cp2077pl/500/500', type: 'dlc', genre: 'DLC / Expansão', parentId: 5,
    prices: { xboxStore: { price: 119.5, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 65.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 6, title: 'Elden Ring', cover: 'https://picsum.photos/seed/eldenring/500/500', type: 'game', genre: 'RPG / Souls-like',
    prices: { xboxStore: { price: 299.9, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 149.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 601, title: 'Elden Ring: Shadow of the Erdtree (DLC)', cover: 'https://picsum.photos/seed/erdtree/500/500', type: 'dlc', genre: 'DLC / Expansão', parentId: 6,
    prices: { xboxStore: { price: 152.5, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 89.9, region: 'Turquia / Global', url: 'https://www.eneba.com/br/' } } },
  { id: 7, title: 'Forza Horizon 5', cover: 'https://picsum.photos/seed/fh5/500/500', type: 'game', genre: 'Corrida',
    prices: { xboxStore: { price: 249.0, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 95.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 701, title: 'Forza Horizon 5: Premium Add-ons Bundle (DLC)', cover: 'https://picsum.photos/seed/fh5prem/500/500', type: 'dlc', genre: 'DLC / Expansão', parentId: 7,
    prices: { xboxStore: { price: 149.0, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 79.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 8, title: 'Starfield', cover: 'https://picsum.photos/seed/starfield/500/500', type: 'game', genre: 'RPG / Sci-Fi',
    prices: { xboxStore: { price: 299.0, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 99.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 801, title: 'Starfield: Shattered Space (DLC)', cover: 'https://picsum.photos/seed/starfieldss/500/500', type: 'dlc', genre: 'DLC / Expansão', parentId: 8,
    prices: { xboxStore: { price: 120.0, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 59.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 9, title: 'Call of Duty: Black Ops 6', cover: 'https://picsum.photos/seed/bo6/500/500', type: 'game', genre: 'Tiro / FPS',
    prices: { xboxStore: { price: 329.0, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 179.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
  { id: 10, title: 'Hogwarts Legacy', cover: 'https://picsum.photos/seed/hogwarts/500/500', type: 'game', genre: 'RPG / Aventura',
    prices: { xboxStore: { price: 299.99, url: 'https://www.xbox.com/pt-BR/games/store' }, eneba: { price: 109.0, region: 'Global', url: 'https://www.eneba.com/br/' } } },
];

const GENRES_LIST = ['Ação / Aventura', 'RPG / Ação', 'Esportes', 'Tiro / FPS', 'Corrida', 'Luta', 'Terror', 'Indie / Plataforma'];

const EXTRA_NAMES = [
  "Assassin's Creed Shadows", 'Resident Evil 9', 'Monster Hunter Wilds', 'Dragon Age: The Veilguard',
  'Metaphor: ReFantazio', 'Silent Hill 2 Remake', 'Dragon Ball: Sparking! Zero', 'Warhammer 40k: Space Marine 2',
  'Tekken 8', 'Street Fighter 6', 'Alan Wake 2', "Baldur's Gate 3", 'Diablo IV', 'Remnant 2', 'Dead Space',
  'Star Wars Jedi: Survivor', 'Hades II', 'Silksong', 'FC 25', 'Mortal Kombat 1', 'Persona 3 Reload', 'Suicide Squad',
  'Skull and Bones', 'Prince of Persia: The Lost Crown', 'Like a Dragon: Infinite Wealth', 'The Last of Us Part I',
  'God of War Ragnarok', 'Spider-Man 2', 'Ghost of Tsushima', 'Final Fantasy VII Rebirth', 'Helldivers 2', 'Palworld',
  'Enshrouded', 'Last Epoch', "Dragon's Dogma 2", 'Rise of the Ronin', 'Stellar Blade', "Senua's Saga: Hellblade II",
  'Devil May Cry 5', 'Resident Evil 4 Remake', 'Dead Island 2', 'Atomic Heart', 'Lies of P', 'The Witcher 3: Wild Hunt',
  'Red Dead Redemption 2', 'Halo Infinite', 'Gears 5', 'Doom Eternal', 'Fallout 4', 'Skyrim Special Edition',
];

const makeSeededRandom = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const buildFullCatalog = () => {
  const items = [...INITIAL_CATALOG];
  const rnd = makeSeededRandom(42);
  let idCounter = 11;

  EXTRA_NAMES.forEach((name, i) => {
    if (items.some((it) => it.title === name)) return;
    const gameId = idCounter++;
    const basePrice = Number((rnd() * 250 + 79.9).toFixed(2));

    items.push({
      id: gameId,
      title: name,
      cover: `https://picsum.photos/seed/game-${gameId}/500/500`,
      type: 'game',
      genre: GENRES_LIST[i % GENRES_LIST.length],
      prices: {
        xboxStore: { price: basePrice, url: 'https://www.xbox.com/pt-BR/games/store' },
        eneba: { price: Number((basePrice * 0.42).toFixed(2)), region: 'Global / Menor Preço', url: 'https://www.eneba.com/br/' },
      },
    });

    items.push({
      id: gameId * 1000 + 1,
      title: `${name}: Expansão Oficial (DLC)`,
      cover: `https://picsum.photos/seed/dlc-${gameId}/500/500`,
      type: 'dlc',
      genre: 'DLC / Expansão',
      parentId: gameId,
      prices: {
        xboxStore: { price: 59.9, url: 'https://www.xbox.com/pt-BR/games/store' },
        eneba: { price: 24.0, region: 'Global / Menor Preço', url: 'https://www.eneba.com/br/' },
      },
    });
  });

  // Pré-computa string de busca em lowercase — evita .toLowerCase() a cada keystroke
  return items.map((it) => ({
    ...it,
    _search: `${it.title} ${it.genre}`.toLowerCase(),
  }));
};

const FULL_CATALOG = buildFullCatalog();

/* ═══════════════════════════════════════════════════════════
   7. HELPERS DE APRESENTAÇÃO
   ═══════════════════════════════════════════════════════════ */

const getBestDeal = (prices) => {
  const eneba = prices?.eneba?.price ?? Infinity;
  const xbox = prices?.xboxStore?.price ?? Infinity;
  return eneba <= xbox
    ? { store: 'eneba', price: eneba }
    : { store: 'xboxStore', price: xbox };
};

const storeLabel = (k) => (k === 'eneba' ? 'Eneba (Mais Barata)' : 'Xbox Store BR');

const STORE_CLASS = {
  eneba: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  xboxStore: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
};

const bestDealCache = new WeakMap();
const getCachedBestDeal = (prices) => {
  if (!prices) return { store: 'xboxStore', price: 0 };
  let cached = bestDealCache.get(prices);
  if (!cached) {
    cached = getBestDeal(prices);
    bestDealCache.set(prices, cached);
  }
  return cached;
};

/* ═══════════════════════════════════════════════════════════
   8. ERROR BOUNDARY
   ═══════════════════════════════════════════════════════════ */

class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('App crash:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
          <div className="max-w-md text-center flex flex-col gap-3">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto" />
            <h1 className="text-xl font-bold">Algo deu errado</h1>
            <p className="text-sm text-slate-400 break-words">
              {this.state.error?.message || 'Erro desconhecido.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2 px-4 rounded mt-2"
            >
              Recarregar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ═══════════════════════════════════════════════════════════
   9. COMPONENTES
   ═══════════════════════════════════════════════════════════ */

function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-800 border border-slate-700 text-slate-100 px-4 py-2 rounded-lg shadow-lg text-sm">
      {message}
    </div>
  );
}

const GameCard = memo(function GameCard({
  item,
  isWishlisted,
  onToggleWishlist,
  onOpenAlert,
}) {
  const best = getCachedBestDeal(item.prices);
  const eneba = item.prices?.eneba;
  const xbox = item.prices?.xboxStore;

  const savings =
    xbox && eneba && xbox.price > eneba.price
      ? Math.round(((xbox.price - eneba.price) / xbox.price) * 100)
      : 0;

  const offerUrl = best.store === 'eneba' ? eneba?.url : xbox?.url;

  return (
    <div
      style={CV_STYLE}
      className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col"
    >
      <div className="relative aspect-square bg-slate-800">
        <img
          src={item.cover}
          alt={item.title}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onError={(e) => {
            e.currentTarget.src = 'https://picsum.photos/seed/fallback/500/500';
          }}
        />
        {savings > 0 && (
          <span className="absolute top-2 left-2 bg-emerald-500 text-slate-950 text-xs font-bold px-2 py-1 rounded flex items-center gap-1">
            <Zap className="w-3 h-3" /> -{savings}%
          </span>
        )}
        <button
          onClick={() => onToggleWishlist(item.id)}
          aria-label="Favoritar"
          className={`absolute top-2 right-2 p-2 rounded-full backdrop-blur border transition-colors ${
            isWishlisted
              ? 'bg-amber-400/90 text-slate-900 border-amber-400'
              : 'bg-slate-900/70 text-slate-300 border-slate-700'
          }`}
        >
          <Bookmark className="w-4 h-4" fill={isWishlisted ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
            {item.genre}
          </span>
          {item.type === 'dlc' && (
            <span className="px-2 py-0
