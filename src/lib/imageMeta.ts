/**
 * imageMeta — odczyt PROWENIENCJI obrazu wg standardów (IPTC „Digital Source Type" + obecność C2PA).
 *
 * Sygnał AI: IPTC `digitalSourceType` (kontrolowany słownik). Wartość jest zapisywana ASCII zarówno w XMP
 * (rdf:resource=…/trainedAlgorithmicMedia), jak i w manifeście C2PA (tekst w CBOR), więc wyszukujemy ją wprost
 * w nagłówku pliku — bez pełnego parsera XMP/CBOR. Pełna weryfikacja podpisu C2PA = przyszły moduł natywny;
 * tu wykrywamy tylko OBECNOŚĆ Content Credentials.
 *
 * Wydajność/bezpieczeństwo: czytamy tylko PREFIX pliku, limit współbieżności, cache w pamięci + AsyncStorage.
 * Każdy błąd (brak dostępu, content:// bez localUri, itp.) → gracefully `undefined`/null (etykieta spada na tag lokalny).
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SourceType = 'ai' | 'aiComposite' | 'capture' | null;
export type Provenance = { sourceType: SourceType; hasC2PA: boolean };

const PREFIX = 256 * 1024;            // ile bajtów nagłówka czytać (XMP/EXIF/C2PA są blisko początku)
const MAX_CONCURRENT = 3;             // nie czytaj wielu plików naraz (siatka miniatur)
const CACHE_KEY = 'gallery_ai:provenance'; // lekka prowieniencja (sourceType/hasC2PA) — zgodny z oryginalnym cache

// base64 → „latin1" (bajt = znak); wystarcza do wyszukania ASCII-owych markerów
const B64I = (() => {
  const t = new Int8Array(256).fill(-1);
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = i;
  return t;
})();
function b64ToStr(b64: string): string {
  let out = '', buf = 0, bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = B64I[b64.charCodeAt(i) & 0xff];
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xff); }
  }
  return out;
}

/** Klasyfikacja po surowym nagłówku: szukamy identyfikatorów IPTC digitalSourceType + markerów C2PA. */
function parse(raw: string): Provenance {
  let sourceType: SourceType = null;
  if (/compositeWithTrainedAlgorithmicMedia/i.test(raw)) sourceType = 'aiComposite';
  else if (/trainedAlgorithmicMedia/i.test(raw)) sourceType = 'ai';
  else if (/digitalCapture|(?:negative|positive)Film|softwareImage|print\b|minorHumanEdits|compositeCapture|algorithmicallyEnhanced/i.test(raw)) sourceType = 'capture';
  const hasC2PA = /jumbf|c2pa\.|urn:uuid:[0-9a-f-]+.{0,64}c2pa|contentcredentials|content_credentials/i.test(raw);
  return { sourceType, hasC2PA };
}

// współbieżność
let running = 0;
const q: Array<() => void> = [];
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const run = () => { running++; fn().then((r) => { running--; resolve(r); const n = q.shift(); if (n) n(); }); };
    if (running < MAX_CONCURRENT) run(); else q.push(run);
  });
}

// cache
let cache: Record<string, Provenance> | null = null;
async function loadCache(): Promise<Record<string, Provenance>> {
  if (cache) return cache;
  try { const raw = await AsyncStorage.getItem(CACHE_KEY); cache = raw ? JSON.parse(raw) : {}; } catch { cache = {}; }
  return cache!;
}
let persistT: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistT) return;
  persistT = setTimeout(() => { persistT = null; AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache ?? {})).catch(() => {}); }, 1500);
}

// LEKKI odczyt: czytamy TYLKO nagłówek pliku (content:// / file://) do klasyfikacji AI/C2PA. Świadomie BEZ
// `getAssetInfoAsync` — to natywne wywołanie KOPIUJE cały plik zdjęcia do cache (żeby dać localUri), a getProvenance
// leci dla KAŻDEJ miniatury (badge AI) → kopiowanie N plików = zapaść FPS. Rozmiar pliku pobiera osobno getFileBytes.
async function compute(assetId: string): Promise<Provenance | undefined> {
  const uri = /^(file|content):/i.test(assetId) ? assetId : null;
  if (!uri) return undefined;
  try {
    const FS: any = await import('expo-file-system/legacy');
    const b64 = await FS.readAsStringAsync(uri, { encoding: 'base64', position: 0, length: PREFIX });
    return parse(b64ToStr(b64));
  } catch { return undefined; }
}

/** Prowieniencja obrazu (z cache). Web / błąd → { sourceType:null, hasC2PA:false }. */
export async function getProvenance(assetId: string): Promise<Provenance> {
  if (Platform.OS === 'web' || !assetId) return { sourceType: null, hasC2PA: false };
  const c = await loadCache();
  if (c[assetId]) return c[assetId];
  const pv = await schedule(() => compute(assetId));
  if (pv) { c[assetId] = pv; persist(); return pv; }  // cache TYLKO udane odczyty (błąd = spróbuj ponownie)
  return { sourceType: null, hasC2PA: false };
}

export const isAiSource = (t: SourceType) => t === 'ai' || t === 'aiComposite';

// Rozmiar pliku (bajty) — TYLKO dla pojedynczego, otwartego obrazu (panel INFO). getInfoAsync stat-uje plik BEZ
// kopiowania (w przeciwieństwie do getAssetInfoAsync). Best-effort + cache; content:// może nie zwrócić `size` → null.
const bytesCache: Record<string, number | null> = {};
export async function getFileBytes(assetId: string): Promise<number | null> {
  if (Platform.OS === 'web' || !assetId) return null;
  if (assetId in bytesCache) return bytesCache[assetId];
  let bytes: number | null = null;
  try {
    const FS: any = await import('expo-file-system/legacy');
    const info = await FS.getInfoAsync(assetId, { size: true });
    if (typeof info?.size === 'number') bytes = info.size;
  } catch { /* best-effort */ }
  bytesCache[assetId] = bytes;
  return bytes;
}
