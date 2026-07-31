/**
 * MaskCanvas — współdzielona powierzchnia maski malowanej PALCEM + sterowanie pędzlem (rozmiar / tryb add-remove).
 * Używana przez MAGIC ERASE i TEXT TO IMAGE (inpainting). Zdjęcie może być przygaszone „welonem"; namalowany
 * obszar świeci fosforem (add) lub jest wycinany (remove).
 *
 * MASKA IDZIE DO BACKENDU — `getMask()` oddaje pociągnięcia WEKTOROWO (kilka kB JSON-a) zamiast rasteryzować
 * PNG na telefonie. Rasteryzuje je proxy, już w rozdzielczości realnego zdjęcia (patrz server/src/mask.ts),
 * dzięki czemu maska nigdy się nie rozjeżdża ze zdjęciem, a apka nie potrzebuje canvasa ani Skii.
 *
 * WSPÓŁRZĘDNE: pociągnięcia trzymamy ZNORMALIZOWANE (0…1 względem pola obrazu), a nie w pikselach ekranu —
 * to ten sam układ, w którym rozumie je backend, i maska przeżywa zmianę rozmiaru pola (device ⇄ fullscreen,
 * obrót), zamiast rozjeżdżać się względem zdjęcia. `size` = szerokość pędzla znormalizowana do SZEROKOŚCI pola.
 *
 * Podział odpowiedzialności: MaskCanvas trzyma pędzel (rozmiar/tryb) + pociągnięcia + POD-PASEK (MODE / BRUSH
 * SIZE). PASEK GŁÓWNY (zakładki) i logikę „apply/send" trzyma rodzic (MagicEraseStage / AiStage).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, Image as RNImage, ImageSourcePropType, LayoutChangeEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import Svg, { Path, Defs, Mask, Rect, Image as SvgImage } from 'react-native-svg';
import { color, font, screen, textShadow } from '../theme/tokens';
import { hapticTick, hapticDetent } from '../lib/haptics';
import { MenuBar } from '../components/chrome/MenuBar';
import type { MaskPaths } from '../lib/deapi';

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
const RING = 2;                     // grubość fosforowej obwódki (px) — powstaje na KAŻDEJ krawędzi zaznaczenia (add i remove)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

type Pt = { x: number; y: number };            // 0…1 względem pola obrazu
type Stroke = { mode: 0 | 1; size: number; pts: Pt[] }; // size = 0…1 względem SZEROKOŚCI pola

/** Ścieżka SVG z punktów znormalizowanych; skala = rozmiar pola. Pojedynczy punkt → kropka (round cap). */
function toPath(pts: Pt[], w: number, h: number): string {
  const [head, ...rest] = pts;
  if (!head) return '';
  const at = (p: Pt) => `${p.x * w} ${p.y * h}`;
  return `M ${at(head)} ` + (rest.length ? rest.map((p) => `L ${at(p)}`).join(' ') : `L ${at(head)}`);
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
  getMask: () => MaskPaths | null; // maska dla backendu (null = nic nie zamalowano)
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
  const rawUri = resolved?.uri ?? '';
  const [ratio, setRatio] = useState(resolved?.width && resolved?.height ? resolved.width / resolved.height : 1);
  // NORMALIZACJA EXIF: manipulator dekoduje obraz z uwzględnieniem orientacji i zapisuje „prosto". Używamy tego
  // samego (upright) źródła do TŁA (ExpoImage) I do odsłony w SVG (SvgImage rysuje surowe piksele — bez EXIF
  // odsłonięty obraz był obrócony). `w/h` z manipulatora = poprawny (obrócony) aspekt pola.
  const [norm, setNorm] = useState<{ uri: string; w: number; h: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNorm(null);
    if (!rawUri) return;
    ImageManipulator.manipulateAsync(rawUri, [], { format: ImageManipulator.SaveFormat.PNG })
      .then((r) => { if (!cancelled) { setNorm({ uri: r.uri, w: r.width, h: r.height }); if (r.width && r.height) setRatio(r.width / r.height); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [rawUri]);
  const displayUri = norm?.uri ?? rawUri;
  const imgSource: ImageSourcePropType = norm ? { uri: norm.uri } : source;

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
  const fitRef = useRef(fit); fitRef.current = fit; // responder potrzebuje aktualnego pola do normalizacji
  // ZAZNACZENIE = istnieje choć jedno pociągnięcie ADD. Same pociągnięcia REMOVE nic nie zaznaczają
  // (to gumka), więc rodzic nie może na ich podstawie odblokować APPLY — poszłaby edycja bez maski,
  // czyli na całym zdjęciu.
  const hasSelection = strokes.some((s) => s.mode === 0);
  useEffect(() => { onState?.({ hasStrokes: hasSelection }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [hasSelection]);

  // responder SIEDZI na POLU OBRAZU (fit-box, pointerEvents="box-only"), więc locationX/Y jest wprost we
  // współrzędnych pola — wystarczy podzielić przez jego rozmiar, żeby dostać układ znormalizowany.
  const MIN_STEP = 2; // px ekranu między próbkami pociągnięcia (mniej = niepotrzebnie gęsta ścieżka)
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => paintRef.current,
      onMoveShouldSetPanResponder: () => paintRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const box = fitRef.current;
        if (!paintRef.current || box.w <= 0 || box.h <= 0) return;
        const s: Stroke = {
          mode: modeRef.current,
          size: brushRef.current / box.w,
          pts: [{ x: e.nativeEvent.locationX / box.w, y: e.nativeEvent.locationY / box.h }],
        };
        liveRef.current = s; setLive(s);
        onPaintStart?.();
      },
      onPanResponderMove: (e) => {
        const s = liveRef.current; if (!s) return;
        const box = fitRef.current;
        if (box.w <= 0 || box.h <= 0) return;
        const x = e.nativeEvent.locationX / box.w, y = e.nativeEvent.locationY / box.h;
        const last = s.pts[s.pts.length - 1];
        if (!last || Math.hypot((x - last.x) * box.w, (y - last.y) * box.h) < MIN_STEP) return;
        const ns: Stroke = { ...s, pts: [...s.pts, { x, y }] };
        liveRef.current = ns; setLive(ns);
      },
      onPanResponderRelease: () => { const s = liveRef.current; liveRef.current = null; setLive(null); if (s) setStrokes((arr) => [...arr, s]); },
      onPanResponderTerminate: () => { const s = liveRef.current; liveRef.current = null; setLive(null); if (s) setStrokes((arr) => [...arr, s]); },
    }),
  ).current;

  // strokes ZE STANU są nieaktualne w callbacku handle'a (domknięcie z pierwszego renderu) — do getMask
  // czytamy ref, żeby wysłać dokładnie to, co widać na ekranie.
  const strokesRef = useRef(strokes); strokesRef.current = strokes;

  useImperativeHandle(ref, () => ({
    navValue: (dir: -1 | 1) => {
      if (panelRef.current === 'mode') setMode(dir < 0 ? 0 : 1);
      else if (panelRef.current === 'size') setBrush((n) => clamp(n + dir, BRUSH_MIN, BRUSH_MAX));
    },
    undo: () => setStrokes((arr) => arr.slice(0, -1)),
    reset: () => { setStrokes([]); setLive(null); liveRef.current = null; },
    clear: () => { setStrokes([]); setLive(null); liveRef.current = null; },
    getMask: () => {
      const all = strokesRef.current;
      // sama „gumka" (REMOVE) niczego nie zaznacza → dla backendu to pusta maska; lepiej powiedzieć null
      if (!all.some((s) => s.mode === 0)) return null;
      return { strokes: all.map((s) => ({ add: s.mode === 0, size: s.size, pts: s.pts.map((p) => [p.x, p.y] as [number, number]) })) };
    },
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
      >
        {fit.w > 0 ? (
          // box-only: to POLE jest celem dotyku (nie dzieci) → locationX/Y są względem pola obrazu
          <View style={{ width: fit.w, height: fit.h }} pointerEvents="box-only" {...responder.panHandlers}>
            <ExpoImage
              source={imgSource}
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
                    {/* KSZTAŁT zaznaczenia (fosfor): add=biel, remove=czerń, pełna szerokość pędzla */}
                    <Mask id="mphos" x="0" y="0" width={fit.w} height={fit.h}>
                      {allStrokes.map((s, i) => (
                        <Path key={i} d={toPath(s.pts, fit.w, fit.h)} stroke={s.mode === 0 ? '#fff' : '#000'} strokeWidth={s.size * fit.w} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      ))}
                    </Mask>
                    {/* ODSŁONIĘTY oryginał = kształt WCIĄGNIĘTY o RING (add węższy, remove szerszy) → wokół CAŁEJ
                        granicy (także tam, gdzie odejmowano) zostaje fosforowa obwódka */}
                    <Mask id="mfill" x="0" y="0" width={fit.w} height={fit.h}>
                      {allStrokes.map((s, i) => {
                        const px = s.size * fit.w;
                        return <Path key={i} d={toPath(s.pts, fit.w, fit.h)} stroke={s.mode === 0 ? '#fff' : '#000'} strokeWidth={s.mode === 0 ? Math.max(1, px - 2 * RING) : px + 2 * RING} strokeLinecap="round" strokeLinejoin="round" fill="none" />;
                      })}
                    </Mask>
                  </Defs>
                  {/* fosforowy kształt całego zaznaczenia… */}
                  <Rect x="0" y="0" width={fit.w} height={fit.h} fill={screen.olive.primary} mask="url(#mphos)" />
                  {/* …a na wierzchu jasny oryginał (nieco mniejszy) → z fosforu zostaje tylko obwódka */}
                  {displayUri ? <SvgImage href={{ uri: displayUri }} x="0" y="0" width={fit.w} height={fit.h} preserveAspectRatio="none" mask="url(#mfill)" /> : null}
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
