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

/* ═══════════════════════════════════════════════════════════
   5. GEMINI
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
   6. CATÁLOGO
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
            <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
              DLC
            </span>
          )}
        </div>

        <h3 className="font-semibold text-sm line-clamp-2">{item.title}</h3>

        <div className="mt-auto text-xs">
          <div
            className={`flex items-center justify-between px-2 py-1 rounded border ${
              STORE_CLASS[best.store]
            }`}
          >
            <span className="font-medium">{storeLabel(best.store)}</span>
            <span className="font-bold">{formatBRL(best.price)}</span>
          </div>
        </div>

        <div className="flex gap-2 mt-2">
          <a
            href={offerUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex-1 flex items-center justify-center gap-1 text-xs bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2 rounded"
          >
            <ExternalLink className="w-3 h-3" /> Ver oferta
          </a>
          <button
            onClick={() => onOpenAlert(item)}
            className="flex items-center justify-center gap-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-3 py-2 rounded"
            aria-label="Criar alerta"
          >
            <Bell className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
});


/* ═══════════════════════════════════════════════════════════
   10. HOOKS CUSTOMIZADOS
   ═══════════════════════════════════════════════════════════ */

function useToast() {
  const [message, setMessage] = useState('');
  const timerRef = useRef(null);

  const show = useCallback((msg) => {
    setMessage(msg);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setMessage(''), 3200);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return { message, show };
}

function useFirebaseAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(firebaseConfigured);

  useEffect(() => {
    if (!firebaseConfigured) {
      setLoading(false);
      return;
    }
    let unsub = () => {};
    let cancelled = false;

    (async () => {
      const { auth, mods } = await loadFirebase();
      if (cancelled || !auth || !mods) {
        setLoading(false);
        return;
      }
      unsub = mods.auth.onAuthStateChanged(auth, (u) => {
        setUser(u);
        setLoading(false);
      });
    })();

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const { auth, mods } = await loadFirebase();
    if (!auth || !mods) throw new Error('Firebase não configurado.');
    return mods.auth.signInWithEmailAndPassword(auth, email, password);
  }, []);

  const register = useCallback(async (email, password) => {
    const { auth, mods } = await loadFirebase();
    if (!auth || !mods) throw new Error('Firebase não configurado.');
    return mods.auth.createUserWithEmailAndPassword(auth, email, password);
  }, []);

  const logout = useCallback(async () => {
    const { auth, mods } = await loadFirebase();
    if (!auth || !mods) return;
    return mods.auth.signOut(auth);
  }, []);

  return { user, loading, login, register, logout };
}

function useUserData(userId) {
  const [wishlist, setWishlist] = useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [customAddedGames, setCustomAddedGames] = useState([]);
  const hydratedRef = useRef(false);

  useEffect(() => {
    hydratedRef.current = false;
    const unsub = subscribeUserData(userId, (data) => {
      if (hydratedRef.current) return;
      if (Array.isArray(data.wishlist)) setWishlist(data.wishlist);
      if (Array.isArray(data.activeAlerts)) setActiveAlerts(data.activeAlerts);
      if (Array.isArray(data.customAddedGames)) setCustomAddedGames(data.customAddedGames);
      hydratedRef.current = true;
    });
    return unsub;
  }, [userId]);

  const persist = useCallback(
    async (patch) => {
      try {
        await saveUserData(userId, patch);
      } catch (e) {
        console.error('Erro ao salvar:', e);
      }
    },
    [userId]
  );

  return {
    wishlist,
    setWishlist,
    activeAlerts,
    setActiveAlerts,
    customAddedGames,
    setCustomAddedGames,
    persist,
  };
}

/* ═══════════════════════════════════════════════════════════
   11. APP
   ═══════════════════════════════════════════════════════════ */

function App() {
  const { user, loading

         const { user, loading: authLoading, login, register, logout } = useFirebaseAuth();
const toast = useToast();

const userId = user?.uid || 'anon';
const {
  wishlist,
  setWishlist,
  activeAlerts,
  setActiveAlerts,
  customAddedGames,
  setCustomAddedGames,
  persist,
} = useUserData(userId);

const customGamesRef = useRef(customAddedGames);
const wishlistRef = useRef(wishlist);
const alertsRef = useRef(activeAlerts);
useEffect(() => { customGamesRef.current = customAddedGames; }, [customAddedGames]);
useEffect(() => { wishlistRef.current = wishlist; }, [wishlist]);
useEffect(() => { alertsRef.current = activeAlerts; }, [activeAlerts]);

const [searchTerm, setSearchTerm] = useState('');
const deferredSearch = useDeferredValue(searchTerm);
const [selectedFilter, setSelectedFilter] = useState('all');
const [selectedGenre, setSelectedGenre] = useState('Todos');
const [activeTab, setActiveTab] = useState('radar');

const [isSearchingWeb, setIsSearchingWeb] = useState(false);
const geminiAbortRef = useRef(null);

const [showAuth, setShowAuth] = useState(false);
const [authMode, setAuthMode] = useState('login');
const [emailInput, setEmailInput] = useState('');
const [passwordInput, setPasswordInput] = useState('');
const [authError, setAuthError] = useState('');

const [alertModalGame, setAlertModalGame] = useState(null);
const [alertTargetPrice, setAlertTargetPrice] = useState('');
const [alertChannel, setAlertChannel] = useState('email');
const [alertContact, setAlertContact] = useState(user?.email || '');

useEffect(
  () => () => {
    if (geminiAbortRef.current) geminiAbortRef.current.abort();
  },
  []
);

const handleEmailAuth = async (e) => {
  e.preventDefault();
  setAuthError('');
  if (!firebaseConfigured) {
    setAuthError('Firebase não está configurado.');
    return;
  }
  if (!emailInput || !passwordInput) {
    setAuthError('Preencha e-mail e senha.');
    return;
  }

  try {
    if (authMode === 'register') {
      await register(emailInput, passwordInput);
      toast.show('Conta criada com sucesso!');
    } else {
      await login(emailInput, passwordInput);
      toast.show('Login realizado!');
    }
    setShowAuth(false);
    setEmailInput('');
    setPasswordInput('');
  } catch (err) {
    setAuthError(err?.message || 'Erro na autenticação.');
  }
};

const handleLogout = async () => {
  await logout();
  toast.show('Sessão encerrada.');
};

const performWebSearch = async () => {
  const query = (deferredSearch || searchTerm).trim();
  if (query.length < 2) {
    toast.show('Digite ao menos 2 caracteres.');
    return;
  }
  if (!hasGemini) {
    toast.show('Configure VITE_GEMINI_API_KEY para usar a varredura.');
    return;
  }

  if (geminiAbortRef.current) geminiAbortRef.current.abort();
  const controller = new AbortController();
  geminiAbortRef.current = controller;

  setIsSearchingWeb(true);
  try {
    const data = await searchGamePrice(query, { signal: controller.signal });
    const newItem = { id: Date.now(), ...data };
    const updated = [newItem, ...customGamesRef.current];
    setCustomAddedGames(updated);
    persist({ customAddedGames: updated });
    toast.show(`Adicionado: "${newItem.title}"`);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('Erro na busca:', err);
    toast.show(err.message || 'Não foi possível completar a varredura.');
  } finally {
    if (geminiAbortRef.current === controller) {
      geminiAbortRef.current = null;
      setIsSearchingWeb(false);
    }
  }
};

const toggleWishlist = useCallback(
  (id) => {
    const wasWishlisted = wishlistRef.current.includes(id);
    const updated = wasWishlisted
      ? wishlistRef.current.filter((x) => x !== id)
      : [...wishlistRef.current, id];

    setWishlist(updated);
    persist({ wishlist: updated });
    toast.show(wasWishlisted ? 'Removido dos favoritos.' : 'Adicionado aos favoritos!');
  },
  [persist, setWishlist, toast]
);

const openAlertModal = useCallback(
  (game) => {
    setAlertModalGame(game);
    setAlertTargetPrice('');
    setAlertChannel('email');
    if (!alertContact && user?.email) setAlertContact(user.email);
  },
  [alertContact, user]
);

const handleSaveAlert = async (e) => {
  e.preventDefault();
  if (!alertModalGame) return;
  const price = parseFloat(alertTargetPrice);
  if (!price || price <= 0) {
    toast.show('Informe um preço válido.');
    return;
  }
  if (!alertContact.trim()) {
    toast.show('Informe um contato.');
    return;
  }

  const newAlert = {
    id: Date.now(),
    gameId: alertModalGame.id,
    gameTitle: alertModalGame.title,
    targetPrice: price,
    channel: alertChannel,
    contact: alertContact.trim(),
  };
  const updated = [...alertsRef.current, newAlert];
  setActiveAlerts(updated);
  await persist({ activeAlerts: updated });
  setAlertModalGame(null);
  toast.show('Alerta criado!');
};

const handleDeleteAlert = async (id) => {
  const updated = alertsRef.current.filter((a) => a.id !== id);
  setActiveAlerts(updated);
  await persist({ activeAlerts: updated });
  toast.show('Alerta removido.');
};

const allItems = useMemo(
  () => [...customAddedGames, ...FULL_CATALOG],
  [customAddedGames]
);

const genres = useMemo(
  () => ['Todos', ...Array.from(new Set(allItems.map((g) => g.genre))).sort()],
  [allItems]
);

const filteredGames = useMemo(() => {
  const q = deferredSearch.toLowerCase().trim();
  const wishSet = new Set(wishlist);

  return allItems.filter((item) => {
    if (q && !item._search.includes(q)) return false;
    if (selectedGenre !== 'Todos' && item.genre !== selectedGenre) return false;
    if (selectedFilter !== 'all' && item.type !== selectedFilter) return false;
    if (activeTab === 'wishlist') {
      const matches = wishSet.has(item.id) || (item.parentId && wishSet.has(item.parentId));
      if (!matches) return false;
    }
    return true;
  });
}, [allItems, deferredSearch, selectedGenre, selectedFilter, activeTab, wishlist]);

return (
  <div className="min-h-screen bg-slate-950 text-slate-100">

    <Toast message={toast.message} />

<header className="sticky top-0 z-30 bg-slate-900/85 backdrop-blur border-b border-slate-800">
  <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2">
      <Gamepad2 className="w-6 h-6 text-emerald-400" />
      <h1 className="font-bold text-lg">Xbox Price Radar</h1>
    </div>
    <div className="flex items-center gap-2">
      {authLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
      ) : user ? (
        <>
          <span className="hidden sm:flex items-center gap-1 text-xs text-slate-400">
            <UserIcon className="w-3 h-3" /> {user.email || 'Anônimo'}
          </span>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded"
          >
            <LogOut className="w-3 h-3" /> Sair
          </button>
        </>
      ) : firebaseConfigured ? (
        <button
          onClick={() => setShowAuth(true)}
          className="flex items-center gap-1 text-xs bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-3 py-1.5 rounded"
        >
          <UserIcon className="w-3 h-3" /> Entrar
        </button>
      ) : (
        <span className="text-xs text-slate-500">Modo local</span>
      )}
    </div>
  </div>
</header>

{!firebaseConfigured && (
  <div className="max-w-6xl mx-auto px-4 pt-3">
    <div className="flex items-center gap-2 text-xs bg-slate-800/50 border border-slate-700 text-slate-400 rounded-lg px-3 py-2">
      <AlertCircle className="w-4 h-4 shrink-0" />
      Firebase não configurado — dados salvos em <b>localStorage</b>.
    </div>
  </div>
)}
{firebaseConfigured && !hasGemini && (
  <div className="max-w-6xl mx-auto px-4 pt-3">
    <div className="flex items-center gap-2 text-xs bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-lg px-3 py-2">
      <AlertCircle className="w-4 h-4 shrink-0" />
      Gemini não configurado — botão "Varrer web" desabilitado.
    </div>
  </div>
)}

<main className="max-w-6xl mx-auto px-4 py-5 flex flex-col gap-4">
  <div className="flex flex-col sm:flex-row gap-2">
    <div className="relative flex-1">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Buscar jogo, DLC, gift card..."
        className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-emerald-500"
      />
    </div>
    <button
      onClick={performWebSearch}
      disabled={isSearchingWeb || !hasGemini}
      title={!hasGemini ? 'Configure VITE_GEMINI_API_KEY' : ''}
      className="flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg"
    >
      {isSearchingWeb ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Sparkles className="w-4 h-4" />
      )}
      {isSearchingWeb ? 'Varrendo...' : 'Varrer web'}
    </button>
  </div>

  <nav className="flex gap-2 border-b border-slate-800 overflow-x-auto">
    {[
      { id: 'radar', label: 'Radar', icon: Zap },
      { id: 'wishlist', label: `Favoritos (${wishlist.length})`, icon: Star },
      { id: 'alerts', label: `Alertas (${activeAlerts.length})`, icon: Bell },
    ].map(({ id, label, icon: Icon }) => (
      <button
        key={id}
        onClick={() => setActiveTab(id)}
        className={`flex items-center gap-2 px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition ${
          activeTab === id
            ? 'border-emerald-500 text-emerald-400'
            : 'border-transparent text-slate-400 hover:text-slate-200'
        }`}
      >
        <Icon className="w-4 h-4" /> {label}
      </button>
    ))}
  </nav>

  {activeTab !== 'alerts' && (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 text-xs text-slate-500">
        <Filter className="w-3 h-3" /> Tipo:
      </div>
      {[
        { id: 'all', label: 'Todos' },
        { id: 'game', label: 'Jogos' },
        { id: 'subscription', label: 'Assinaturas' },
        { id: 'dlc', label: 'DLCs' },
      ].map((f) => (
        <button
          key={f.id}
          onClick={() => setSelectedFilter(f.id)}
          className={`text-xs px-3 py-1 rounded-full border ${
            selectedFilter === f.id
              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          {f.label}
        </button>
      ))}

      <span className="ml-2 text-xs text-slate-500">Gênero:</span>
      <select
        value={selectedGenre}
        onChange={(e) => setSelectedGenre(e.target.value)}
        className="text-xs bg-slate-900 border border-slate-800 rounded-full px-3 py-1 text-slate-300 focus:outline-none focus:border-emerald-500"
      >
        {genres.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
    </div>
  )}

    {activeTab === 'alerts' ? (
    <div className="flex flex-col gap-2">
      {activeAlerts.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-10">
          Nenhum alerta criado ainda. Clique no sino de um jogo para criar.
        </p>
      )}
      {activeAlerts.map((a) => (
        <div
          key={a.id}
          className="flex items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-lg px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{a.gameTitle}</p>
            <p className="text-xs text-slate-400">
              Avisar quando ≤{' '}
              <span className="text-emerald-400 font-semibold">
                {formatBRL(a.targetPrice)}
              </span>{' '}
              via {a.channel} → {a.contact}
            </p>
          </div>
          <button
            onClick={() => handleDeleteAlert(a.id)}
            className="p-2 rounded-lg bg-slate-800 hover:bg-red-500/20 hover:text-red-400 text-slate-400 border border-slate-700"
            aria-label="Remover alerta"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  ) : (
    <>
      {filteredGames.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-10">
          {activeTab === 'wishlist'
            ? 'Nenhum favorito ainda. Toque no marcador em qualquer jogo.'
            : 'Nenhum resultado encontrado.'}
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filteredGames.slice(0, 120).map((item) => (
            <GameCard
              key={item.id}
              item={item}
              isWishlisted={wishlist.includes(item.id)}
              onToggleWishlist={toggleWishlist}
              onOpenAlert={openAlertModal}
            />
          ))}
        </div>
      )}
      {filteredGames.length > 120 && (
        <p className="text-xs text-slate-500 text-center">
          Mostrando 120 de {filteredGames.length}. Refine a busca para ver mais.
        </p>
      )}
    </>
  )}
</main>

{alertModalGame && (
  <div
    className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    onClick={() => setAlertModalGame(null)}
  >
    <form
      onClick={(e) => e.stopPropagation()}
      onSubmit={handleSaveAlert}
      className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md p-5 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Criar alerta de preço</h3>
          <p className="text-xs text-slate-400 line-clamp-2">{alertModalGame.title}</p>
        </div>
        <button
          type="button"
          onClick={() => setAlertModalGame(null)}
          className="p-1 rounded hover:bg-slate-800 text-slate-400"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <label className="text-xs text-slate-400 flex flex-col gap-1">
        Preço alvo (R$)
        <input
          type="number"
          min="0"
          step="0.01"
          required
          value={alertTargetPrice}
          onChange={(e) => setAlertTargetPrice(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
        />
      </label>

      <div className="flex gap-2">
        {['email', 'whatsapp'].map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => setAlertChannel(ch)}
            className={`flex-1 text-xs py-2 rounded border ${
              alertChannel === ch
                ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-950 border-slate-800 text-slate-400'
            }`}
          >
            {ch === 'email' ? 'E-mail' : 'WhatsApp'}
          </button>
        ))}
      </div>

      <label className="text-xs text-slate-400 flex flex-col gap-1">
        Contato
        <input
          type={alertChannel === 'email' ? 'email' : 'tel'}
          required
          value={alertContact}
          onChange={(e) => setAlertContact(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
        />
      </label>

      <button
        type="submit"
        className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2 rounded"
      >
        Salvar alerta
      </button>
    </form>
  </div>
)}
