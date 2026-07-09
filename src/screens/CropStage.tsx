/**
 * CropStage — interaktywne kadrowanie (uchwyty w rogach) + prostowanie (Figma CROP: node 406:6786).
 * Zdjęcie „contain" (całe widoczne) w kwadratowym polu; nad nim OKNO KADRU z narożnymi uchwytami „L":
 *   • przeciąganie narożnika = zmiana rozmiaru (przy proporcjach zablokowanych — z zachowaniem proporcji),
 *   • przeciąganie środka = przesunięcie okna.
 * Proporcje: CUSTOM = swobodnie, ORIGINAL = proporcje zdjęcia, 1:1 = kwadrat, 3:2/4:3/16:9 = wg nazwy.
 * Prostowanie pokrętłem (−45°…45°). Wynik: `expo-image-manipulator` (rotate → crop).
 *
 * Matematyka: obraz rysowany „contain" (skala d0 = min(A/W, A/H)) i obracany o θ wokół środka. Biblioteczny
 * rotate rozszerza canvas do bbox Wr×Hr (treść wyśrodkowana), więc canvas i osiowo-równoległe okno kadru
 * mapują się czystym skalowaniem+przesunięciem: originX = (winX − (A/2 − Wr·d0/2)) / d0, cropW = winW / d0.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, Image as RNImage, ImageSourcePropType, LayoutChangeEvent } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { color, font, screen, textShadow } from '../theme/tokens';
import { hapticTick, hapticDetent } from '../lib/haptics';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

// proporcje (kolejność wg Figmy). ratio = szer/wys; null = ORIGINAL(wyliczone) lub CUSTOM(swobodne).
export const ASPECTS = [
  { key: 'CUSTOM', ratio: null as number | null },
  { key: 'ORIGINAL', ratio: null as number | null },
  { key: '1:1', ratio: 1 },
  { key: '3:2', ratio: 3 / 2 },
  { key: '4:3', ratio: 4 / 3 },
  { key: '16:9', ratio: 16 / 9 },
] as const;
const DEFAULT_ASPECT = 2; // '1:1'

const MAX_ANGLE = 180;    // pełny zakres obrotu (−180°…180° = całe 360°)
const HANDLE_HIT = 56;    // promień strefy chwytania narożnika (px) — wygodne łapanie „L"
const MAX_ZOOM = 1.2;     // maksymalny zoom obrazu (120%) — gest dwoma palcami
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// bounding-box obrazu W×H po obrocie o `deg` (identyczne jak sizeFromAngle w bibliotece)
function rotatedBox(W: number, H: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const s = Math.abs(Math.sin(r));
  const c = Math.abs(Math.cos(r));
  return { Wr: H * s + W * c, Hr: H * c + W * s };
}

// czy punkt (px,py) jest wewnątrz prostokąta obrazu (środek cx,cy, półboki hw,hh) obróconego o `deg`
function insideRotRect(px: number, py: number, cx: number, cy: number, hw: number, hh: number, deg: number) {
  const rad = (-deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const dx = px - cx, dy = py - cy;
  const lx = dx * c - dy * s, ly = dx * s + dy * c; // punkt w lokalnym (nieobróconym) układzie obrazu
  return Math.abs(lx) <= hw + 0.5 && Math.abs(ly) <= hh + 0.5;
}

type Rect = { x: number; y: number; w: number; h: number };
type Mode = 'tl' | 'tr' | 'bl' | 'br' | 'move';

/** Domyślne okno kadru: wyśrodkowany prostokąt proporcji `r` (null = swobodny), ~90% pola obrazu. */
function defaultWindow(r: number | null, rect: Rect): Rect {
  const maxW = rect.w * 0.9, maxH = rect.h * 0.9;
  let w = maxW, h = maxH;
  if (r != null) {
    if (r >= 1) { w = maxW; h = w / r; if (h > maxH) { h = maxH; w = h * r; } }
    else { h = maxH; w = h * r; if (w > maxW) { w = maxW; h = w / r; } }
  }
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

/** Który uchwyt/tryb pod punktem (px,py): narożnik, środek (move) albo null. */
function hitTest(px: number, py: number, win: Rect): Mode | null {
  const corners: [Mode, number, number][] = [
    ['tl', win.x, win.y], ['tr', win.x + win.w, win.y], ['bl', win.x, win.y + win.h], ['br', win.x + win.w, win.y + win.h],
  ];
  for (const [k, cx, cy] of corners) if (Math.hypot(px - cx, py - cy) <= HANDLE_HIT) return k;
  if (px >= win.x && px <= win.x + win.w && py >= win.y && py <= win.y + win.h) return 'move';
  return null;
}

/** Nowe okno po przeciągnięciu narożnika `corner` o (dx,dy); kotwica = przeciwny narożnik. */
function resizeWindow(corner: Mode, s: Rect, dx: number, dy: number, r: number | null, bounds: Rect): Rect {
  // kotwica (stała) i narożnik ruchomy (start)
  const A: Record<string, [number, number]> = {
    br: [s.x, s.y], tr: [s.x, s.y + s.h], bl: [s.x + s.w, s.y], tl: [s.x + s.w, s.y + s.h],
  };
  const M: Record<string, [number, number]> = {
    br: [s.x + s.w, s.y + s.h], tr: [s.x + s.w, s.y], bl: [s.x, s.y + s.h], tl: [s.x, s.y],
  };
  const [ax, ay] = A[corner];
  let mx = clamp(M[corner][0] + dx, bounds.x, bounds.x + bounds.w);
  let my = clamp(M[corner][1] + dy, bounds.y, bounds.y + bounds.h);
  const sgnx = mx >= ax ? 1 : -1, sgny = my >= ay ? 1 : -1;
  let w = Math.abs(mx - ax), h = Math.abs(my - ay);
  const MIN = bounds.w * 0.12;
  // maks. rozmiar w kierunku ruchu (żeby zostać w granicach obrazu)
  const maxW = sgnx > 0 ? bounds.x + bounds.w - ax : ax - bounds.x;
  const maxH = sgny > 0 ? bounds.y + bounds.h - ay : ay - bounds.y;
  if (r != null) {
    // dopasuj do proporcji, mieszcząc się w dostępnym w×h
    if (w / h > r) w = h * r; else h = w / r;
    if (w > maxW) { w = maxW; h = w / r; }
    if (h > maxH) { h = maxH; w = h * r; }
    if (w < MIN) { w = MIN; h = w / r; }
    if (h < MIN) { h = MIN; w = h * r; }
  } else {
    w = clamp(w, MIN, maxW); h = clamp(h, MIN, maxH);
  }
  mx = ax + sgnx * w; my = ay + sgny * h;
  return { x: Math.min(ax, mx), y: Math.min(ay, my), w, h };
}

const PILL = { boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any;
const glowIf = (c: string) => (c === screen.olive.primary ? phosphorGlow : null); // glow tylko dla fosforowego tekstu

/**
 * Pokrętło prostowania — listwa z podziałką; przeciąganie w poziomie zmienia kąt. `active` (fokus na rotacji):
 * fosforowa pigułka z ciemnym tekstem/podziałką; inaczej: sam fosforowy tekst nad podziałką.
 */
const DIAL_TICKS = 481;       // podziałka pokrywa cały zakres ±180° z zapasem (brak luk na krawędziach)
const DIAL_SPACING = 5;       // px między kreskami (1° = 1 kreska)
const DETENT = 15;            // zaskok co 15°
const STEP_PX = 6;            // swipe na 1° (poza detentem)
const DETENT_PX = 20;         // dłuższy swipe, by opuścić próg 15° (opór/wskoczenie)
/**
 * RotationDial — pokrętło prostowania. SWIPE po CAŁYM pasku zmienia kąt skokowo co 1° (bardzo krótki tick),
 * z zaskokiem co 15° (opór: trzeba swipnąć dłużej, dłuższy haptic). `onAngle` = kąt bezwzględny.
 */
function RotationDial({ angle, active, onAngle, onActivate }: { angle: number; active: boolean; onAngle: (a: number) => void; onActivate?: () => void }) {
  const acc = useRef(0);       // nieskonsumowane px swipe
  const lastDx = useRef(0);    // g.dx z poprzedniego move (do policzenia przyrostu)
  const work = useRef(0);      // bieżący kąt (int) w trakcie gestu
  const angleRefExternal = useRef(angle); angleRefExternal.current = angle; // aktualny kąt w domknięciu respondera
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 2,
      onPanResponderGrant: () => { acc.current = 0; lastDx.current = 0; work.current = Math.round(angleRefExternal.current); onActivate?.(); },
      onPanResponderMove: (_e, g) => {
        acc.current += g.dx - lastDx.current; lastDx.current = g.dx;
        // konsumuj px na kroki 1°: swipe w lewo (dx<0) → +kąt; próg zależy od tego, czy stoimy na detencie
        for (let guard = 0; guard < 400; guard++) {
          const atDetent = work.current % DETENT === 0;
          const threshold = atDetent ? DETENT_PX : STEP_PX;
          if (Math.abs(acc.current) < threshold) break;
          const dir = acc.current < 0 ? 1 : -1;
          acc.current -= dir < 0 ? threshold : -threshold; // zmniejsz |acc| o próg
          const next = clamp(work.current + dir, -MAX_ANGLE, MAX_ANGLE);
          if (next === work.current) { acc.current = 0; break; }
          work.current = next;
          onAngle(next);
          if (next % DETENT === 0) hapticDetent(); else hapticTick();
        }
      },
      onPanResponderRelease: () => { acc.current = 0; lastDx.current = 0; },
      onPanResponderTerminate: () => { acc.current = 0; lastDx.current = 0; },
    }),
  ).current;

  const ticks = useMemo(
    () => Array.from({ length: DIAL_TICKS }).map((_, i) => (i - (DIAL_TICKS - 1) / 2) % DETENT === 0),
    [],
  );
  const fg = active ? color.dark21 : screen.olive.primary;
  const tick = active ? 'rgba(33,33,33,0.55)' : screen.olive.secondary;
  return (
    <View
      {...responder.panHandlers}
      style={[{ alignItems: 'center', gap: 4, alignSelf: 'stretch', borderRadius: 2, paddingVertical: 8 }, active ? { backgroundColor: screen.olive.primary, ...PILL } : null]}
    >
      <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: fg, ...glowIf(fg) }}>
        {`${angle.toFixed(2)}°`}
      </Text>
      <View style={{ height: 28, alignSelf: 'stretch', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row', transform: [{ translateX: -angle * DIAL_SPACING }] }}>
          {ticks.map((major, i) => (
            <View key={i} style={{ width: 1, height: major ? 16 : 9, marginRight: DIAL_SPACING - 1, backgroundColor: tick }} />
          ))}
        </View>
        <View pointerEvents="none" style={{ position: 'absolute', width: 2, height: 22, backgroundColor: fg, ...(active ? null : PILL) }} />
      </View>
    </View>
  );
}

/**
 * Pasek proporcji. `active` (fokus na proporcjach): fosforowe tło, ciemny tekst, zaznaczone = ciemna pastylka
 * z fosforowym tekstem. Nieaktywny: bez tła, fosforowy tekst, zaznaczone = fosforowa pigułka z ciemnym tekstem.
 */
function AspectBar({ index, active, onPick }: { index: number; active: boolean; onPick: (i: number) => void }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  const itemColor = active ? color.dark21 : screen.olive.primary;
  const selBg = active ? color.dark21 : screen.olive.primary;
  const selColor = active ? screen.olive.primary : color.dark21;
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 2 }, active ? { backgroundColor: screen.olive.primary, ...PILL } : null]}>
      {ASPECTS.map((a, i) =>
        i === index ? (
          <Pressable key={a.key} onPress={() => onPick(i)} style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 1, paddingHorizontal: 3, borderRadius: 2, backgroundColor: selBg }}>
            <Text style={{ ...txt, color: selColor, ...glowIf(selColor) }}>{'•'}</Text>
            <Text style={{ ...txt, color: selColor, ...glowIf(selColor) }}>{a.key}</Text>
          </Pressable>
        ) : (
          <Pressable key={a.key} onPress={() => onPick(i)}>
            <Text style={{ ...txt, color: itemColor, ...glowIf(itemColor) }}>{a.key}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

/** Narożne uchwyty kadru „L" (Figma cropmarks) — 4 rogi × 2 ramiona, fosfor z poświatą. */
function CornerMarks({ left, top, w, h }: { left: number; top: number; w: number; h: number }) {
  const arm = Math.min(w, h) * 0.16;
  const t = 2;
  const c = screen.olive.primary;
  const seg = (s: object) => <View pointerEvents="none" style={{ position: 'absolute', backgroundColor: c, ...PILL, ...s }} />;
  return (
    <>
      {seg({ left, top, width: arm, height: t })}{seg({ left, top, width: t, height: arm })}
      {seg({ left: left + w - arm, top, width: arm, height: t })}{seg({ left: left + w - t, top, width: t, height: arm })}
      {seg({ left, top: top + h - t, width: arm, height: t })}{seg({ left, top: top + h - arm, width: t, height: arm })}
      {seg({ left: left + w - arm, top: top + h - t, width: arm, height: t })}{seg({ left: left + w - t, top: top + h - arm, width: t, height: arm })}
    </>
  );
}

export type CropHandle = {
  focusRotation: () => void;
  focusRatio: () => void;
  adjust: (dir: -1 | 1) => void; // AKTYWNY panel: rotacja ±1° / proporcje prev-next
  rotateBy: (delta: number) => void; // precyzyjna rotacja (metale)
  reset: () => void;
  // wykonuje kadr/rotację; `needsFill` = kadr wychodzi poza obrócone zdjęcie (puste obszary do wypełnienia AI)
  apply: () => Promise<{ uri: string; needsFill: boolean } | null>;
};

export const CropStage = forwardRef<CropHandle, { source: ImageSourcePropType }>(function CropStage({ source }, ref) {
  const initDims = useMemo(() => {
    try { const a = RNImage.resolveAssetSource(source as any); return { W: a?.width || 1, H: a?.height || 1 }; } catch { return { W: 1, H: 1 }; }
  }, [source]);
  const [dims, setDims] = useState(initDims);
  const rawUri = useMemo(() => { try { return RNImage.resolveAssetSource(source as any)?.uri ?? ''; } catch { return ''; } }, [source]);

  // NORMALIZACJA: raz na wejściu wypalamy orientację EXIF (przez manipulator) i dalej pracujemy na tym
  // samym obrazie do wyświetlania I kadrowania — inaczej na telefonie zdjęcia z aparatu (EXIF) dają
  // rozjechany kadr (RNImage prostuje, a piksele/wymiary bywają w surowej orientacji).
  const [norm, setNorm] = useState<{ uri: string; W: number; H: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNorm(null);
    if (!rawUri) return;
    ImageManipulator.manipulateAsync(rawUri, [], { format: ImageManipulator.SaveFormat.PNG })
      .then((r) => { if (!cancelled) setNorm({ uri: r.uri, W: r.width, H: r.height }); })
      .catch(() => {}); // fallback: oryginał + wymiary z onLoad
    return () => { cancelled = true; };
  }, [rawUri]);
  const uri = norm?.uri ?? rawUri;
  const imgSource: ImageSourcePropType = norm ? { uri: norm.uri } : source;

  const [area, setArea] = useState(0);          // bok kwadratowego pola (px ekranu)
  const [aspectIdx, setAspectIdx] = useState(DEFAULT_ASPECT);
  const [angle, setAngle] = useState(0);
  const angleRef = useRef(0); angleRef.current = angle;
  const [focus, setFocus] = useState<'ratio' | 'rotation'>('ratio');
  const [win, setWin] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 }); // okno kadru w układzie pola
  const [zoom, setZoom] = useState(1); // zoom obrazu (1…MAX_ZOOM) — gest dwoma palcami
  const zoomRef = useRef(1); zoomRef.current = zoom;

  const W = norm ? norm.W : dims.W, H = norm ? norm.H : dims.H; // wymiary znormalizowanego obrazu
  const ratio = ASPECTS[aspectIdx].key === 'ORIGINAL' ? W / H : ASPECTS[aspectIdx].ratio; // null = CUSTOM
  const d0 = area > 0 ? Math.min(area / W, area / H) : 0; // skala „contain" (całe zdjęcie widoczne, θ=0)
  const imageRect: Rect = useMemo(
    () => ({ x: (area - W * d0) / 2, y: (area - H * d0) / 2, w: W * d0, h: H * d0 }),
    [area, W, H, d0],
  );

  // refy dla PanRespondera (tworzony raz) — bieżąca geometria/okno/tryb
  const winRef = useRef(win); winRef.current = win;
  const rectRef = useRef(imageRect); rectRef.current = imageRect;
  const ratioRef = useRef<number | null>(ratio); ratioRef.current = ratio;
  const modeRef = useRef<Mode | null>(null);
  const startWinRef = useRef<Rect>(win);
  const pinchRef = useRef<{ dist: number; ang: number; z0: number; a0: number } | null>(null);
  const didPinchRef = useRef(false); // w tym geście były 2 palce → nie wracaj do przeciągania okna

  // reset okna kadru przy zmianie proporcji / pola / wymiarów (NIE przy rotacji — kąt nie resetuje kadru)
  useEffect(() => {
    if (area <= 0) return;
    setWin(defaultWindow(ratio, imageRect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspectIdx, area, W, H]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        modeRef.current = hitTest(locationX, locationY, winRef.current);
        startWinRef.current = winRef.current;
        pinchRef.current = null; didPinchRef.current = false;
      },
      onPanResponderMove: (e, g) => {
        const ts = e.nativeEvent.touches;
        // DWA PALCE → zoom (1…MAX_ZOOM) + obrót obrazu
        if (ts.length >= 2) {
          didPinchRef.current = true;
          const dx = ts[0].pageX - ts[1].pageX, dy = ts[0].pageY - ts[1].pageY;
          const dist = Math.hypot(dx, dy);
          const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (!pinchRef.current) { pinchRef.current = { dist, ang, z0: zoomRef.current, a0: angleRef.current }; return; }
          const p = pinchRef.current;
          const z = clamp(p.z0 * (dist / p.dist), 1, MAX_ZOOM);
          zoomRef.current = z; setZoom(z);
          const na = clamp(p.a0 + (ang - p.ang), -MAX_ANGLE, MAX_ANGLE);
          angleRef.current = na; setAngle(na);
          return;
        }
        // JEDEN PALEC → kadr (narożnik = rozmiar, środek = przesunięcie). Po dwupalcowym geście — nic.
        if (didPinchRef.current) return;
        const m = modeRef.current;
        if (!m) return;
        const s = startWinRef.current, b = rectRef.current;
        let next: Rect;
        if (m === 'move') {
          next = {
            x: clamp(s.x + g.dx, b.x, b.x + b.w - s.w),
            y: clamp(s.y + g.dy, b.y, b.y + b.h - s.h),
            w: s.w, h: s.h,
          };
        } else {
          next = resizeWindow(m, s, g.dx, g.dy, ratioRef.current, b);
        }
        winRef.current = next;
        setWin(next);
      },
      onPanResponderRelease: () => { modeRef.current = null; pinchRef.current = null; didPinchRef.current = false; },
      onPanResponderTerminate: () => { modeRef.current = null; pinchRef.current = null; didPinchRef.current = false; },
    }),
  ).current;

  const setAngleClamped = (deg: number) => { const a = clamp(deg, -MAX_ANGLE, MAX_ANGLE); angleRef.current = a; setAngle(a); };
  const focusRef = useRef<'ratio' | 'rotation'>('ratio'); focusRef.current = focus;

  useImperativeHandle(ref, () => ({
    focusRotation: () => setFocus('rotation'),
    focusRatio: () => setFocus('ratio'),
    adjust: (dir: -1 | 1) => {
      if (focusRef.current === 'rotation') setAngleClamped(angleRef.current + dir);
      else setAspectIdx((i) => (i + dir + ASPECTS.length) % ASPECTS.length);
    },
    rotateBy: (delta: number) => { setFocus('rotation'); setAngleClamped(angleRef.current + delta); },
    reset: () => { setAspectIdx(DEFAULT_ASPECT); setAngleClamped(0); setZoom(1); zoomRef.current = 1; setWin(defaultWindow(1, rectRef.current)); },
    apply: async () => {
      if (!uri || area <= 0 || d0 <= 0) return null;
      const d = d0 * zoomRef.current; // efektywna skala px→ekran (contain × zoom)
      const { Wr, Hr } = rotatedBox(W, H, angleRef.current);
      const canvasLeft = area / 2 - (Wr * d) / 2, canvasTop = area / 2 - (Hr * d) / 2;
      const w = winRef.current;
      const rect = {
        originX: clamp((w.x - canvasLeft) / d, 0, Math.max(0, Wr - 1)),
        originY: clamp((w.y - canvasTop) / d, 0, Math.max(0, Hr - 1)),
        width: clamp(w.w / d, 1, Wr),
        height: clamp(w.h / d, 1, Hr),
      };
      // czy kadr wychodzi poza obrócone (i zoomowane) zdjęcie → puste rogi (kandydat do wypełnienia AI)
      const cx = area / 2, cy = area / 2, hw = (W * d) / 2, hh = (H * d) / 2, a = angleRef.current;
      const corners: [number, number][] = [[w.x, w.y], [w.x + w.w, w.y], [w.x, w.y + w.h], [w.x + w.w, w.y + w.h]];
      const needsFill = corners.some(([px, py]) => !insideRotRect(px, py, cx, cy, hw, hh, a));

      const actions: ImageManipulator.Action[] = [];
      if (Math.abs(angleRef.current) > 0.001) actions.push({ rotate: angleRef.current });
      actions.push({ crop: rect });
      try {
        const res = await ImageManipulator.manipulateAsync(uri, actions, { compress: 1, format: ImageManipulator.SaveFormat.PNG });
        return { uri: res.uri, needsFill };
      } catch {
        return null;
      }
    },
  }), [uri, area, d0, W, H]);

  const imgW = W * d0, imgH = H * d0;
  const dim = { position: 'absolute' as const, backgroundColor: 'rgba(26,26,26,0.6)' };
  const stroke = 'rgba(226,255,228,0.25)';

  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 16 }}>
      {/* POLE KADRU — kwadrat = szerokość treści; holder flex:1 wypełnia górę, sterowanie płynie pod nim */}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View
          onLayout={(e: LayoutChangeEvent) => { const w = e.nativeEvent.layout.width; setArea((a) => (Math.abs(a - w) < 1 ? a : w)); }}
          style={{ width: '100%', aspectRatio: 1, borderRadius: 2, overflow: 'hidden' }}
          {...responder.panHandlers}
        >
          {/* zdjęcie „contain", obracane o θ wokół środka */}
          {area > 0 && d0 > 0 ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: area / 2, top: area / 2,
                width: imgW, height: imgH,
                marginLeft: -imgW / 2, marginTop: -imgH / 2,
                transform: [{ scale: zoom }, { rotate: `${angle}deg` }],
              }}
            >
              <RNImage
                source={imgSource}
                resizeMode="stretch"
                onLoad={(ev: any) => { const s = ev?.nativeEvent?.source; if (s?.width && s?.height) setDims({ W: s.width, H: s.height }); }}
                style={{ width: '100%', height: '100%' }}
              />
            </View>
          ) : null}

          {/* przyciemnienie poza oknem kadru (4 pasy) + ramka + narożne uchwyty „L" */}
          {area > 0 && win.w > 0 ? (
            <>
              <View pointerEvents="none" style={{ ...dim, left: 0, right: 0, top: 0, height: win.y }} />
              <View pointerEvents="none" style={{ ...dim, left: 0, right: 0, top: win.y + win.h, bottom: 0 }} />
              <View pointerEvents="none" style={{ ...dim, top: win.y, height: win.h, left: 0, width: win.x }} />
              <View pointerEvents="none" style={{ ...dim, top: win.y, height: win.h, left: win.x + win.w, right: 0 }} />
              <View pointerEvents="none" style={{ position: 'absolute', left: win.x, top: win.y, width: win.w, height: win.h, borderWidth: 1, borderColor: stroke }} />
              <CornerMarks left={win.x} top={win.y} w={win.w} h={win.h} />
            </>
          ) : null}
        </View>
      </View>

      {/* STEROWANIE (dwustopniowe): aktywny panel podświetlony. Tap w panel = fokus + akcja. */}
      <View style={{ gap: 12, alignSelf: 'stretch' }}>
        <RotationDial
          angle={angle}
          active={focus === 'rotation'}
          onActivate={() => setFocus('rotation')}
          onAngle={(a) => setAngleClamped(a)}
        />
        <AspectBar index={aspectIdx} active={focus === 'ratio'} onPick={(i) => { setFocus('ratio'); setAspectIdx(i); }} />
      </View>
    </View>
  );
});
