/**
 * MagicEraseStage — MAGIC ERASE (Figma _AI 424:6660). Zaznaczasz PALCEM obszar (maska: MaskCanvas), a AI
 * usuwa go i domalowuje tło. Ten komponent trzyma tylko PASEK GŁÓWNY (MODE / BRUSH SIZE / REMOVE BACKGROUND)
 * + logikę apply (erase / remove-background); malowanie i pędzel są w [[MaskCanvas]].
 *
 * Klawiatura (w EditorScreen): APPLY · UNDO · joy · RESET · BACK; po zastosowaniu → SAVE.
 * STAN: APPLY woła STUB deAPI (echo) — realny inpaint z maską po podłączeniu proxy (rasteryzacja = TODO).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Image as RNImage, ImageSourcePropType } from 'react-native';
import { MaskCanvas, MaskCanvasHandle } from './MaskCanvas';
import { MenuBar } from '../components/chrome/MenuBar';
import { eraseImage, removeBackground } from '../lib/deapi';

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
  onState?: (s: MagicEraseState) => void;
}>(function MagicEraseStage({ source, onResult, onState }, ref) {
  const baseUri = useMemo(() => { try { return RNImage.resolveAssetSource(source as any)?.uri ?? ''; } catch { return ''; } }, [source]);
  const maskRef = useRef<MaskCanvasHandle>(null);

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
      const res = removeBg ? await removeBackground({ uri: baseUri }) : await eraseImage({ uri: baseUri });
      if (res?.uri) { setApplied(true); onResult?.(res.uri); maskRef.current?.clear(); }
    } catch { /* stub nie rzuca; realny błąd → zostaw stan do ponowienia */ } finally {
      setProcessing(false);
    }
  };

  useImperativeHandle(ref, () => ({
    navLeft: () => { if (levelRef.current === 'second') maskRef.current?.navValue(-1); else setFirst((i) => Math.max(0, i - 1)); },
    navRight: () => { if (levelRef.current === 'second') maskRef.current?.navValue(1); else setFirst((i) => Math.min(FIRST_TABS.length - 1, i + 1)); },
    navUp: () => {}, // w górę NIE odsłania poziomu 2 — do tego służy zatwierdzenie (press/tap)
    navDown: () => {}, // zwijanie poziomu 2 TYLKO przez BACK — pion joysticka tego nie robi (mylące)
    press: () => { if (levelRef.current === 'first' && firstRef.current !== 2) setLevel('second'); },
    collapse: () => { if (levelRef.current === 'second') { setLevel('first'); return true; } return false; },
    apply: () => { void doApply(); },
    undo: () => maskRef.current?.undo(),
    reset: () => { maskRef.current?.reset(); setApplied(false); onResult?.(null); },
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
