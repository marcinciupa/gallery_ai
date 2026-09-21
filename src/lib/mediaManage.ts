/**
 * mediaManage — „Aplikacje do zarządzania multimediami" (`MANAGE_MEDIA`, Android 12+).
 *
 * PO CO: bez niego Android przy każdym trwałym kasowaniu i każdym MOVE cudzego zdjęcia (z aparatu, z innych
 * apek) pokazuje systemowe okno zgody. Z nim system SAM zatwierdza te prośby (createDeleteRequest /
 * createWriteRequest, którymi idzie expo-media-library) — okna nie ma. Zweryfikowane na emulatorze 2026-09-21.
 *
 * DLACZEGO TO, a nie „dostęp do wszystkich plików": `MANAGE_EXTERNAL_STORAGE` Google Play odrzuciło (galeria nie
 * jest dozwolonym zastosowaniem). `MANAGE_MEDIA` obejmuje wyłącznie multimedia i NIE jest na liście uprawnień
 * ograniczonych Play — bez formularza deklaracji. Tak działają galerie spoza systemu.
 *
 * ⚠️ To uprawnienie SPECJALNE: przyznaje je przełącznik na osobnym ekranie ustawień systemu, nie runtime-owe
 * pytanie. Stan i ekran ustawień daje lokalny moduł natywny `modules/media-manage` (JS nie ma do tego API).
 * Android 11 go nie zna — tam okna zgody zostają i nie mamy o co prosić.
 */
import MediaManage from '../../modules/media-manage';

/** Czy jest o co prosić: Android 12+ i moduł natywny obecny (nie web, nie Expo Go). */
export const mediaManageSupported = (): boolean => {
  try { return !!MediaManage?.isSupported(); } catch { return false; }
};

/** Czy przełącznik jest włączony. Czytane na żywo — działa od razu po powrocie z ustawień, bez restartu. */
export const canManageMedia = (): boolean => {
  try { return !!MediaManage?.canManageMedia(); } catch { return false; }
};

/** Otwiera systemowy ekran z przełącznikiem dla NASZEJ apki. false = nie udało się go otworzyć. */
export const openMediaManageSettings = (): boolean => {
  try { return !!MediaManage?.openSettings(); } catch { return false; }
};
