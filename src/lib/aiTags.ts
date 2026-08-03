/**
 * aiTags — trwały rejestr ID assetów, które powstały z ingerencją AI w tej apce (persist w AsyncStorage).
 * Używane do etykiety „AI" na miniaturach. Docelowo zastąpione odczytem C2PA / IPTC digitalSourceType z pliku
 * (standard provenance) — tu lokalny znacznik dla zdjęć zapisanych po edycji AI (TEXT-TO-IMAGE / ERASE / FILL…).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'gallery_ai:ai_tagged_ids';
let cache: Set<string> | null = null;

export async function getAiTags(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    cache = new Set<string>();
  }
  return cache;
}

/**
 * Przeniesienie znacznika na NOWE id assetu. Potrzebne przy MOVE: przenoszenie realizujemy jako
 * wstawienie kopii + skasowanie oryginału (patrz mediaOps), więc plik dostaje nowe content:// URI,
 * a tag trzymamy właśnie po URI — bez tego przeniesione zdjęcie gubiłoby etykietę „AI".
 */
export async function retagAiAsset(oldId: string, newId: string): Promise<void> {
  if (!oldId || !newId) return;
  const s = await getAiTags();
  if (!s.has(oldId)) return;
  s.delete(oldId);
  s.add(newId);
  try { await AsyncStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* zapis best-effort */ }
}

export async function addAiTag(id: string): Promise<void> {
  if (!id) return;
  const s = await getAiTags();
  if (s.has(id)) return;
  s.add(id);
  try { await AsyncStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* zapis best-effort */ }
}
