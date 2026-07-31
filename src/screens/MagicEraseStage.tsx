/**
 * MagicEraseStage — MAGIC ERASE (Figma _AI 424:6660). Zaznaczasz PALCEM obszar (maska: MaskCanvas), a AI
 * usuwa go i domalowuje tło. Ten komponent trzyma tylko PASEK GŁÓWNY (MODE / BRUSH SIZE / REMOVE BACKGROUND)
 * + logikę apply (erase / remove-background); malowanie i pędzel są w [[MaskCanvas]].
 *
 * Klawiatura (w EditorScreen): APPLY · UNDO · joy · RESET · BACK; po zastosowaniu → SAVE.
 * APPLY wysyła zdjęcie RAZEM z maską — proxy kadruje wycinek wokół zaznaczenia i składa wynik z
 * oryginałem, więc usuwanie zostaje w zamalowanym obszarze (bez maski model przerabiał całe zdjęcie).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Image as RNImage, ImageSourcePropType } from 'react-native';
import { MaskCanvas, MaskCanvasHandle } from './MaskCanvas';
import { MenuBar } from '../components/chrome/MenuBar';
import { eraseImage, removeBackground } from '../lib/deapi';
import { ensureLocalFile } from '../lib/localFile';

const FIRST_TABS = ['MODE', 'BRUSH SIZE', 'REMOVE BACKGROUND'] as const;

export type MagicEraseState = { applied: boolean; hasSelection: boolean; removeBg: boolean; processing: boolean };
export type MagicEraseHandle = {
  navLeft: () => void; navRight: () => void; navUp: () => void; navDown: () => void; press: () => void;
  /** BACK: zwiń poziom 2 do poziomu 1. Zwraca true, jeśli było co zwijać (wtedy BACK nie zamyka widoku). */
  collapse: () => boolean;
  apply: () => void; // erase (maska) albo remove-background (zależnie od zakładki)
  undo: () => void;
  reset: () => void;
};

export const MagicEraseStage = forwardRef<MagicEraseHandle, {
  source: ImageSourcePropType;
  onResult?: (uri: string | null) => void;
  onError?: (msg: string) => void; // błąd backendu do pokazania użytkownikowi (rodzic: toast)
  onState?: (s: MagicEraseState) => void;
}>(function MagicEraseStage({ source, onResult, onError, onState }, ref) {
  const baseUri = useMemo(() => { try { return RNImage.resolveAssetSource(source as any)?.uri ?? ''; } catch { return ''; } }, [source]);
  const maskRef = useRef<MaskCanvasHandle>(null);
  // Propy w refach: `useImperativeHandle` (deps `[baseUri]`) zamraża `doApply`, a razem z nim domknięte
  // propy. Bez tego APPLY po przełączeniu na REMOVE BACKGROUND raportowało wynik callbackiem sprzed
  // przełączenia i w panelu INFO lądował zły ślad AI („MAGIC ERASE" zamiast „REMOVE BG").
  const onResultRef = useRef(onResult); onResultRef.current = onResult;
  const onErrorRef = useRef(onError); onErrorRef.current = onError;

  const [first, setFirst] = useState(0);          // MODE / BRUSH SIZE / REMOVE BACKGROUND
  const [level, setLevel] = useState<'first' | 'second'>('first');
  const [applied, setApplied] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);

  const firstRef = useRef(first); firstRef.current = first;
  const levelRef = useRef(level); levelRef.current = level;
  const processingRef = useRef(processing); processingRef.current = processing;
  const strokesRef = useRef(hasStrokes); strokesRef.current = hasStrokes;

  // zakładka REMOVE BACKGROUND nie ma pod-paska → fokus wraca na pasek główny
  useEffect(() => { if (first === 2 && level === 'second') setLevel('first'); }, [first, level]);
  useEffect(() => { onState?.({ applied, hasSelection: hasStrokes, removeBg: first === 2, processing }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [applied, hasStrokes, first, processing]);

  const doApply = async () => {
    if (processingRef.current || !baseUri) return;
    const removeBg = firstRef.current === 2;
    if (!removeBg && !strokesRef.current) return; // nic nie zaznaczono
    setProcessing(true);
    try {
      // maska = zamalowany obszar; bez niej backend usuwałby „cokolwiek niechcianego" z całego zdjęcia
      const res = removeBg ? await removeBackground({ uri: baseUri }) : await eraseImage({ uri: baseUri, mask: maskRef.current?.getMask() });
      if (res?.uri) {
        // Trasa z maską oddaje gotowy obraz jako `data:` (kompozycja proxy), a nie krótki URL — bez
        // sprowadzenia do pliku wielomegabajtowy string krążyłby po stanie, kluczach komponentów
        // i cache'u obrazów (ścieżka TEXT TO IMAGE robi to samo).
        const local = await ensureLocalFile(res.uri);
        setApplied(true);
        onResultRef.current?.(local);
        maskRef.current?.clear();
      }
    } catch (e) {
      // Widok MAGIC ERASE nie ma gdzie renderować błędu, więc bez tego 400/422/502/timeout kończył się
      // samym zniknięciem napisu „ERASING…" — użytkownik nie wiedział, że cokolwiek poszło nie tak.
      onErrorRef.current?.(e instanceof Error ? `ERROR: ${e.message}` : 'ERASE FAILED');
    } finally {
      setProcessing(false);
    }
  };

  useImperativeHandle(ref, () => ({
    navLeft: () => { if (levelRef.current === 'second') maskRef.current?.navValue(-1); else setFirst((i) => Math.max(0, i - 1)); },
    navRight: () => { if (levelRef.current === 'second') maskRef.current?.navValue(1); else setFirst((i) => Math.min(FIRST_TABS.length - 1, i + 1)); },
    navUp: () => { if (firstRef.current !== 2) setLevel('second'); }, // wejście na poziom 2 (REMOVE BG go nie ma)
    navDown: () => setLevel('first'),  // cofnięcie na poziom 1
    press: () => { if (levelRef.current === 'first' && firstRef.current !== 2) setLevel('second'); },
    collapse: () => { if (levelRef.current === 'second') { setLevel('first'); return true; } return false; },
    apply: () => { void doApply(); },
    undo: () => maskRef.current?.undo(),
    reset: () => { maskRef.current?.reset(); setApplied(false); onResultRef.current?.(null); },
  }), [baseUri]);

  // Poziom 2 odsłania się DOPIERO po zatwierdzeniu zakładki (patrz AiStage — ta sama zasada).
  const panel = level !== 'second' ? null : first === 0 ? 'mode' : first === 1 ? 'size' : null;

  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 16 }}>
      <MaskCanvas
        ref={maskRef}
        source={source}
        dimmed={!applied && first !== 2}
        paintEnabled={!processing && first !== 2}
        panel={panel}
        secondFocused={level === 'second'}
        onState={(s) => setHasStrokes(s.hasStrokes)}
        onPaintStart={() => setApplied(false)}
        onInteractPanel={() => setLevel('second')}
      />
      <MenuBar items={FIRST_TABS} index={first} focused={level === 'first'} onPick={(i) => { setFirst(i); setLevel(i === 2 ? 'first' : 'second'); }} />
    </View>
  );
});
