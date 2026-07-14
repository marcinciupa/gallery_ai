/**
 * MaskCanvas — współdzielona powierzchnia maski malowanej PALCEM + sterowanie pędzlem (rozmiar / tryb add-remove).
 * Używana przez MAGIC ERASE i TEXT TO IMAGE (inpainting). Zdjęcie może być przygaszone „welonem"; namalowany
 * obszar świeci fosforem (add) lub jest wycinany (remove). Rasteryzacja maski do PNG dla backendu = TODO.
 *
 * Podział odpowiedzialności: MaskCanvas trzyma pędzel (rozmiar/tryb) + pociągnięcia + POD-PASEK (MODE / BRUSH
 * SIZE). PASEK GŁÓWNY (zakładki) i logikę „apply/send" trzyma rodzic (MagicEraseStage / AiStage).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, Image as RNImage, ImageSourcePropType, LayoutChangeEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Path, Defs, Mask, Rect, Image as SvgImage } from 'react-native-svg';
import { color, font, screen, textShadow } from '../theme/tokens';
import { hapticTick, hapticDetent } from '../lib/haptics';
import { MenuBar } from '../components/chrome/MenuBar';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;
const PILL = { boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as const;

export const SELECT_MODES = ['ADD TO SELECT', 'REMOVE FROM SELECT'] as const; // 0=add, 1=remove
export const BRUSH_MIN = 1, BRUSH_MAX = 20, BRUSH_DEF = 10;
const BRUSH_STEP_PX = 14; // px przeciągnięcia na 1 jednostkę rozmiaru
const VEIL = 'rgba(26,26,26,0.72)'; // przygaszenie niezaznaczonego zdjęcia (zaznaczenie świeci jasnym oryginałem)
const HALO = 4;                     // grubość fosforowej obwódki wokół zaznaczenia (px, po ~2px na bok)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

type Pt = { x: number; y: number };
type Stroke = { mode: 0 | 1; size: number; pts: Pt[] };

/** Ścieżka SVG z punktów; pojedynczy punkt → kropka (round cap). */
function toPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  const [h, ...t] = pts;
  return `M ${h.x} ${h.y} ` + (t.length ? t.map((p) => `L ${p.x} ${p.y}`).join(' ') : `L ${h.x} ${h.y}`);
}

/**
 * Pokrętło rozmiaru pędzla — STAŁA podziałka 1…20 (nie przesuwa się); bieżąca wartość = podświetlona,
 * wyższa kreska (znacznik). Przeciąganie w poziomie zmienia rozmiar; joystick ‹/› reguluje o 1.
 */
function BrushDial({ size, onSize }: { size: number; onSize: (n: number) => void }) {
  const startRef = useRef(0);
  const lastRef = useRef(0);
  const sizeRef = useRef(size); sizeRef.current = size;
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { startRef.current = sizeRef.current; lastRef.current = Math.round(sizeRef.current); },
      onPanResponderMove: (_e, g) => {
        const raw = clamp(startRef.current + g.dx / BRUSH_STEP_PX, BRUSH_MIN, BRUSH_MAX);
        const n = Math.round(raw);
        if (n !== lastRef.current) { if (n % 5 === 0) hapticDetent(); else hapticTick(); lastRef.current = n; }
        onSize(n);
      },
    }),
  ).current;
  const fg = screen.olive.primary;
  return (
    <View {...responder.panHandlers} style={{ alignItems: 'center', gap: 4, alignSelf: 'stretch', paddingVertical: 8 }}>
      <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: fg, ...phosphorGlow }}>{`${size}`}</Text>
      {/* podziałka STAŁA: 20 kresek równo (flex), aktywna = jasna+wyższa; kreski co 5 nieco wyższe */}
      <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', height: 22 }}>
        {Array.from({ length: BRUSH_MAX - BRUSH_MIN + 1 }).map((_, i) => {
          const v = BRUSH_MIN + i;
          const active = v === size;
          const major = v % 5 === 0;
          return (
            <View key={v} style={{ flex: 1, alignItems: 'center' }}>
              <View style={{ width: active ? 3 : major ? 2 : 1, height: active ? 20 : major ? 13 : 8, borderRadius: 1, backgroundColor: active || major ? fg : screen.olive.secondary, ...(active ? (PILL as any) : null) }} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

export type MaskCanvasHandle = {
  navValue: (dir: -1 | 1) => void; // reguluj aktywny pod-panel (MODE: add/remove; SIZE: −/+)
  undo: () => void;                // cofnij ostatnie pociągnięcie
  reset: () => void;               // wyczyść maskę
  clear: () => void;               // wyczyść maskę bez raportu (np. po wysłaniu)
};

export const MaskCanvas = forwardRef<MaskCanvasHandle, {
  source: ImageSourcePropType;
  dimmed: boolean;                       // welon + maska (false = czysty obraz)
  paintEnabled: boolean;                 // czy można malować
  panel: 'mode' | 'size' | null;         // który pod-panel pokazać
  secondFocused: boolean;                // joystick na pod-panelu (dim)
  onState?: (s: { hasStrokes: boolean }) => void;
  onPaintStart?: () => void;             // pierwszy dotyk pociągnięcia (rodzic: np. wyjdź ze stanu „applied")
  onInteractPanel?: () => void;          // tap/drag na pod-pasku → rodzic ustawia fokus na 2. poziom
}>(function MaskCanvas({ source, dimmed, paintEnabled, panel, secondFocused, onState, onPaintStart, onInteractPanel }, ref) {
  const resolved = useMemo(() => { try { return RNImage.resolveAssetSource(source as any); } catch { return null; } }, [source]);
  const uri = resolved?.uri ?? '';
  const [ratio, setRatio] = useState(resolved?.width && resolved?.height ? resolved.width / resolved.height : 1);

  const [areaW, setAreaW] = useState(0);
  const [areaH, setAreaH] = useState(0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Stroke | null>(null);
  const [brush, setBrush] = useState(BRUSH_DEF);
  const [mode, setMode] = useState<0 | 1>(0);

  const liveRef = useRef<Stroke | null>(null);
  const brushRef = useRef(brush); brushRef.current = brush;
  const modeRef = useRef(mode); modeRef.current = mode;
  const paintRef = useRef(paintEnabled); paintRef.current = paintEnabled;
  const panelRef = useRef(panel); panelRef.current = panel;

  const fit = areaW > 0 && areaH > 0
    ? (areaW / areaH > ratio ? { w: areaH * ratio, h: areaH } : { w: areaW, h: areaW / ratio })
    : { w: 0, h: 0 };
  const boxRef = useRef({ ox: 0, oy: 0 });
  boxRef.current = { ox: (areaW - fit.w) / 2, oy: (areaH - fit.h) / 2 };

  useEffect(() => { onState?.({ hasStrokes: strokes.length > 0 }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [strokes.length]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => paintRef.current,
      onMoveShouldSetPanResponder: () => paintRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        if (!paintRef.current) return;
        const b = boxRef.current;
        const x = e.nativeEvent.locationX - b.ox, y = e.nativeEvent.locationY - b.oy;
        const s: Stroke = { mode: modeRef.current, size: brushRef.current, pts: [{ x, y }] };
        liveRef.current = s; setLive(s);
        onPaintStart?.();
      },
      onPanResponderMove: (e) => {
        const s = liveRef.current; if (!s) return;
        const b = boxRef.current;
        const x = e.nativeEvent.locationX - b.ox, y = e.nativeEvent.locationY - b.oy;
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(x - last.x, y - last.y) < 2) return;
        const ns: Stroke = { ...s, pts: [...s.pts, { x, y }] };
        liveRef.current = ns; setLive(ns);
      },
      onPanResponderRelease: () => { const s = liveRef.current; liveRef.current = null; setLive(null); if (s) setStrokes((arr) => [...arr, s]); },
      onPanResponderTerminate: () => { const s = liveRef.current; liveRef.current = null; setLive(null); if (s) setStrokes((arr) => [...arr, s]); },
    }),
  ).current;

  useImperativeHandle(ref, () => ({
    navValue: (dir: -1 | 1) => {
      if (panelRef.current === 'mode') setMode(dir < 0 ? 0 : 1);
      else if (panelRef.current === 'size') setBrush((n) => clamp(n + dir, BRUSH_MIN, BRUSH_MAX));
    },
    undo: () => setStrokes((arr) => arr.slice(0, -1)),
    reset: () => { setStrokes([]); setLive(null); liveRef.current = null; },
    clear: () => { setStrokes([]); setLive(null); liveRef.current = null; },
  }), []);

  const allStrokes = live ? [...strokes, live] : strokes;

  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 12 }}>
      <View
        onLayout={(e: LayoutChangeEvent) => {
          const { width, height } = e.nativeEvent.layout;
          setAreaW((a) => (Math.abs(a - width) < 1 ? a : width));
          setAreaH((a) => (Math.abs(a - height) < 1 ? a : height));
        }}
        style={{ flex: 1, alignSelf: 'stretch', borderRadius: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
        {...responder.panHandlers}
      >
        {fit.w > 0 ? (
          <View style={{ width: fit.w, height: fit.h }}>
            <ExpoImage
              source={source}
              contentFit="fill"
              cachePolicy="memory-disk"
              transition={0}
              onLoad={(ev: any) => { const s = ev?.source; if (s?.width && s?.height) setRatio(s.width / s.height); }}
              style={{ width: '100%', height: '100%' }}
            />
            {dimmed ? (
              <>
                {/* welon przygasza całe zdjęcie… */}
                <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: VEIL }} />
                {/* …a zaznaczenie odsłania JASNY oryginał (maska) + fosforowa obwódka. add=biel(odsłoń), remove=czerń(schowaj). */}
                <Svg pointerEvents="none" width={fit.w} height={fit.h} style={{ position: 'absolute', left: 0, top: 0 }}>
                  <Defs>
                    <Mask id="mfill" x="0" y="0" width={fit.w} height={fit.h}>
                      {allStrokes.map((s, i) => (
                        <Path key={i} d={toPath(s.pts)} stroke={s.mode === 0 ? '#fff' : '#000'} strokeWidth={s.size} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      ))}
                    </Mask>
                    <Mask id="mhalo" x="0" y="0" width={fit.w} height={fit.h}>
                      {allStrokes.map((s, i) => (
                        <Path key={i} d={toPath(s.pts)} stroke={s.mode === 0 ? '#fff' : '#000'} strokeWidth={s.size + HALO} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      ))}
                    </Mask>
                  </Defs>
                  {/* fosforowy kształt (nieco większy) → z niego zostaje obwódka po nałożeniu jasnego obrazu */}
                  <Rect x="0" y="0" width={fit.w} height={fit.h} fill={screen.olive.primary} mask="url(#mhalo)" />
                  {/* jasny oryginał tylko wewnątrz zaznaczenia */}
                  {uri ? <SvgImage href={{ uri }} x="0" y="0" width={fit.w} height={fit.h} preserveAspectRatio="none" mask="url(#mfill)" /> : null}
                </Svg>
              </>
            ) : null}
          </View>
        ) : null}
      </View>

      {panel === 'mode' ? <MenuBar items={SELECT_MODES} index={mode} focused={secondFocused} onPick={(i) => { onInteractPanel?.(); setMode(i as 0 | 1); }} /> : null}
      {panel === 'size' ? <BrushDial size={brush} onSize={(n) => { onInteractPanel?.(); setBrush(n); }} /> : null}
    </View>
  );
});
