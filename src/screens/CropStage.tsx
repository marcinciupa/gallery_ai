/**
 * CropStage — interaktywne kadrowanie + prostowanie (Figma CROP: node 402:5599).
 * Obraz w kwadratowym polu: pan + pinch-zoom framing, prostowanie pokrętłem (−45°…45°), pasek proporcji
 * (CUSTOM/ORIGINAL/1:1/3:2/4:3/16:9). Realny wynik przez `expo-image-manipulator` (rotate → crop).
 *
 * Matematyka kadru (zgodna z web-implementacją biblioteki: rotate rozszerza canvas do bounding-boxa Wr×Hr,
 * treść wyśrodkowana): okno kadru i canvas są OSIOWO-RÓWNOLEGŁE w przestrzeni ekranu, więc mapowanie
 * ekran→piksele to czyste skalowanie+przesunięcie:
 *   originX = (winLeft − (Cx − Wr·d/2)) / d ,  cropW = winW / d   (Wr,Hr = bbox po rotacji, d = skala px→ekran)
 * Sterowanie (rotate/ratio/reset/apply) wystawione przez ref — klawiatura edytora je woła.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Animated, PanResponder, Image as RNImage, ImageSourcePropType, LayoutChangeEvent } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { color, font, screen, textShadow } from '../theme/tokens';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

// proporcje (kolejność wg Figmy). ratio = szer/wys; null = wolne (v1 = pełne kwadratowe pole).
export const ASPECTS = [
  { key: 'CUSTOM', ratio: null as number | null },
  { key: 'ORIGINAL', ratio: null as number | null }, // wyliczone z wymiarów zdjęcia
  { key: '1:1', ratio: 1 },
  { key: '3:2', ratio: 3 / 2 },
  { key: '4:3', ratio: 4 / 3 },
  { key: '16:9', ratio: 16 / 9 },
] as const;
const DEFAULT_ASPECT = 2; // '1:1'

const MAX_ANGLE = 45;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// bounding-box obrazu W×H po obrocie o `deg` (identyczne jak sizeFromAngle w bibliotece)
function rotatedBox(W: number, H: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const s = Math.abs(Math.sin(r));
  const c = Math.abs(Math.cos(r));
  return { Wr: H * s + W * c, Hr: H * c + W * s };
}

export type CropHandle = {
  focusRotation: () => void;   // fokus na panel rotacji
  focusRatio: () => void;      // fokus na panel proporcji
  adjust: (dir: -1 | 1) => void; // reguluj AKTYWNY panel (rotacja ±1° / proporcje prev-next)
  rotateBy: (delta: number) => void; // precyzyjna rotacja (metale — zawsze, niezależnie od fokusu)
  reset: () => void;
  apply: () => Promise<string | null>;
};

const PILL = { boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any;
const glowIf = (c: string) => (c === screen.olive.primary ? phosphorGlow : null); // glow tylko dla fosforowego tekstu

/**
 * Pokrętło prostowania — listwa z podziałką; przeciąganie w poziomie zmienia kąt. `active` (fokus na rotacji):
 * fosforowa pigułka z ciemnym tekstem/podziałką; inaczej: sam fosforowy tekst nad podziałką.
 */
function RotationDial({ angle, active, onDelta }: { angle: number; active: boolean; onDelta: (d: number) => void }) {
  const last = useRef(0);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { last.current = 0; },
      onPanResponderMove: (_e, g) => {
        // 4 px przesunięcia = 1°; przeciąganie w lewo zwiększa kąt (obrót zgodnie z ruchem treści)
        const deg = -g.dx / 4;
        onDelta(deg - last.current);
        last.current = deg;
      },
      onPanResponderRelease: () => { last.current = 0; },
    }),
  ).current;
  const TICKS = 41; // co ~2.25° na skali szerokości
  const spacing = 8;
  const fg = active ? color.dark21 : screen.olive.primary;
  const tick = active ? 'rgba(33,33,33,0.55)' : screen.olive.secondary;
  return (
    <View style={[{ alignItems: 'center', gap: 4, alignSelf: 'stretch', borderRadius: 2 }, active ? { backgroundColor: screen.olive.primary, paddingVertical: 8, ...PILL } : null]}>
      <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: fg, ...glowIf(fg) }}>
        {`${angle.toFixed(2)}°`}
      </Text>
      <View style={{ height: 24, alignSelf: 'stretch', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }} {...responder.panHandlers}>
        <View style={{ flexDirection: 'row', transform: [{ translateX: -(angle / (90 / (TICKS - 1))) * spacing }] }}>
          {Array.from({ length: TICKS }).map((_, i) => {
            const major = (i - (TICKS - 1) / 2) % 5 === 0;
            return <View key={i} style={{ width: 1, height: major ? 16 : 9, marginRight: spacing - 1, backgroundColor: tick }} />;
          })}
        </View>
        {/* wskaźnik środka (0° względem bieżącego kąta) */}
        <View pointerEvents="none" style={{ position: 'absolute', width: 2, height: 20, backgroundColor: fg, ...(active ? null : PILL) }} />
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
  const itemColor = active ? color.dark21 : screen.olive.primary;      // niezaznaczone
  const selBg = active ? color.dark21 : screen.olive.primary;          // pastylka zaznaczenia
  const selColor = active ? screen.olive.primary : color.dark21;       // tekst zaznaczenia
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

export const CropStage = forwardRef<CropHandle, { source: ImageSourcePropType }>(function CropStage({ source }, ref) {
  // wymiary źródła (px) — z resolveAssetSource, doprecyzowane w onLoad
  const initDims = useMemo(() => {
    try { const a = RNImage.resolveAssetSource(source as any); return { W: a?.width || 1, H: a?.height || 1 }; } catch { return { W: 1, H: 1 }; }
  }, [source]);
  const [dims, setDims] = useState(initDims);
  const uri = useMemo(() => { try { return RNImage.resolveAssetSource(source as any)?.uri ?? ''; } catch { return ''; } }, [source]);

  const [area, setArea] = useState(0);         // bok kwadratowego pola kadru (px ekranu)
  const [aspectIdx, setAspectIdx] = useState(DEFAULT_ASPECT);
  const [angle, setAngle] = useState(0);        // stopnie (−45..45)
  const [focus, setFocus] = useState<'ratio' | 'rotation'>('ratio'); // aktywny panel (dwustopniowe menu)
  const focusRef = useRef<'ratio' | 'rotation'>('ratio');
  focusRef.current = focus;

  // pinch/pan (Animated dla płynności; refy trzymają bieżące wartości do matematyki apply)
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const txAnim = useRef(new Animated.Value(0)).current;
  const tyAnim = useRef(new Animated.Value(0)).current;
  const cur = useRef({ s: 1, x: 0, y: 0 });
  const base = useRef({ s: 1, x: 0, y: 0 });
  const pinch = useRef<{ d0: number; s0: number } | null>(null);
  const angleRef = useRef(0);

  const W = dims.W, H = dims.H;
  const ratio = ASPECTS[aspectIdx].key === 'ORIGINAL' ? W / H : ASPECTS[aspectIdx].ratio; // null → kwadrat
  // okno kadru w polu A×A: dopasowane do proporcji, z marginesem
  const win = useMemo(() => {
    if (area <= 0) return { w: 0, h: 0, left: 0, top: 0 };
    const maxSide = area * 0.86;
    const r = ratio ?? 1;
    let w = maxSide, h = maxSide;
    if (r >= 1) { w = maxSide; h = w / r; if (h > maxSide) { h = maxSide; w = h * r; } }
    else { h = maxSide; w = h * r; if (w > maxSide) { w = maxSide; h = w / r; } }
    return { w, h, left: (area - w) / 2, top: (area - h) / 2 };
  }, [area, ratio]);

  // skala px→ekran, tak by bbox po rotacji POKRYWAŁ okno (cover) przy zoom=1
  const baseD = useMemo(() => {
    if (area <= 0) return 0;
    const { Wr, Hr } = rotatedBox(W, H, angle);
    return Math.max(win.w / Wr, win.h / Hr);
  }, [area, W, H, angle, win.w, win.h]);

  // geometria czytana przez PanResponder (tworzony raz) — ref, żeby nie zamrozić wartości z 1. renderu (area=0)
  const geomRef = useRef({ baseD: 0, winW: 0, winH: 0 });

  // clamp panu tak, by okno zostało pokryte przez bbox (bez pustych pól w kadrze)
  const clampPan = (x: number, y: number, s: number) => {
    const g = geomRef.current;
    const d = g.baseD * s;
    const { Wr, Hr } = rotatedBox(W, H, angleRef.current);
    const maxX = Math.max(0, (Wr * d - g.winW) / 2);
    const maxY = Math.max(0, (Hr * d - g.winH) / 2);
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { base.current = { ...cur.current }; pinch.current = null; },
      onPanResponderMove: (e, g) => {
        const ts = e.nativeEvent.touches;
        if (ts.length >= 2) {
          const d = Math.hypot(ts[0].pageX - ts[1].pageX, ts[0].pageY - ts[1].pageY);
          if (!pinch.current) pinch.current = { d0: d, s0: base.current.s };
          const s = clamp(pinch.current.s0 * (d / pinch.current.d0), 1, 8);
          const p = clampPan(cur.current.x, cur.current.y, s);
          cur.current.s = s; cur.current.x = p.x; cur.current.y = p.y;
          scaleAnim.setValue(s); txAnim.setValue(p.x); tyAnim.setValue(p.y);
        } else if (ts.length === 1) {
          const p = clampPan(base.current.x + g.dx, base.current.y + g.dy, base.current.s);
          cur.current.x = p.x; cur.current.y = p.y;
          txAnim.setValue(p.x); tyAnim.setValue(p.y);
        }
      },
      onPanResponderRelease: () => { pinch.current = null; base.current = { ...cur.current }; },
    }),
  ).current;

  const setAngleClamped = (deg: number) => {
    const a = clamp(deg, -MAX_ANGLE, MAX_ANGLE);
    angleRef.current = a;
    setAngle(a);
    // po zmianie kąta bbox się zmienia → skoryguj pan, by okno zostało pokryte
    const p = clampPan(cur.current.x, cur.current.y, cur.current.s);
    cur.current.x = p.x; cur.current.y = p.y;
    txAnim.setValue(p.x); tyAnim.setValue(p.y);
  };

  useImperativeHandle(ref, () => ({
    focusRotation: () => setFocus('rotation'),
    focusRatio: () => setFocus('ratio'),
    adjust: (dir: -1 | 1) => {
      if (focusRef.current === 'rotation') setAngleClamped(angleRef.current + dir);
      else setAspectIdx((i) => (i + dir + ASPECTS.length) % ASPECTS.length);
    },
    rotateBy: (delta: number) => { setFocus('rotation'); setAngleClamped(angleRef.current + delta); },
    reset: () => {
      setAspectIdx(DEFAULT_ASPECT);
      setAngleClamped(0);
      cur.current = { s: 1, x: 0, y: 0 }; base.current = { s: 1, x: 0, y: 0 };
      scaleAnim.setValue(1); txAnim.setValue(0); tyAnim.setValue(0);
    },
    apply: async () => {
      if (!uri || area <= 0) return null;
      const s = cur.current.s, d = baseD * s;
      if (d <= 0) return null;
      const { Wr, Hr } = rotatedBox(W, H, angleRef.current);
      // środek obrazu na ekranie (w układzie pola A×A): środek pola + pan
      const Cx = area / 2 + cur.current.x, Cy = area / 2 + cur.current.y;
      // lewy-górny róg bbox po rotacji na ekranie
      const canvasLeft = Cx - (Wr * d) / 2, canvasTop = Cy - (Hr * d) / 2;
      const originX = (win.left - canvasLeft) / d;
      const originY = (win.top - canvasTop) / d;
      const cropW = win.w / d, cropH = win.h / d;
      const rect = {
        originX: clamp(originX, 0, Math.max(0, Wr - 1)),
        originY: clamp(originY, 0, Math.max(0, Hr - 1)),
        width: clamp(cropW, 1, Wr),
        height: clamp(cropH, 1, Hr),
      };
      const actions: ImageManipulator.Action[] = [];
      if (Math.abs(angleRef.current) > 0.001) actions.push({ rotate: angleRef.current });
      actions.push({ crop: rect });
      try {
        const res = await ImageManipulator.manipulateAsync(uri, actions, { compress: 1, format: ImageManipulator.SaveFormat.PNG });
        return res.uri;
      } catch (e) {
        return null;
      }
    },
  }), [uri, area, baseD, W, H, win.w, win.h, win.left, win.top]);

  geomRef.current = { baseD, winW: win.w, winH: win.h }; // aktualizuj geometrię dla PanRespondera
  const imgW = W * baseD, imgH = H * baseD; // rozmiar przy zoom=1; Animated.scale dokłada zoom
  const dim = { position: 'absolute' as const, backgroundColor: 'rgba(26,26,26,0.6)' };
  const stroke = 'rgba(226,255,228,0.25)';

  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 16 }}>
      {/* POLE KADRU — kwadrat = szerokość treści; holder flex:1 wypełnia górę, sterowanie płynie pod nim
          w normalnym przepływie (bez position:absolute, wbrew Figmie) */}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View
          onLayout={(e: LayoutChangeEvent) => { const w = e.nativeEvent.layout.width; setArea((a) => (Math.abs(a - w) < 1 ? a : w)); }}
          style={{ width: '100%', aspectRatio: 1, backgroundColor: '#000', borderRadius: 2, overflow: 'hidden' }}
          {...responder.panHandlers}
        >
          {area > 0 && baseD > 0 ? (
            <Animated.View
              style={{
                position: 'absolute',
                left: area / 2, top: area / 2,
                width: imgW, height: imgH,
                marginLeft: -imgW / 2, marginTop: -imgH / 2,
                transform: [{ translateX: txAnim }, { translateY: tyAnim }, { scale: scaleAnim }, { rotate: `${angle}deg` }],
              }}
            >
              <RNImage
                source={source}
                resizeMode="stretch"
                onLoad={(ev: any) => { const s = ev?.nativeEvent?.source; if (s?.width && s?.height) setDims({ W: s.width, H: s.height }); }}
                style={{ width: '100%', height: '100%' }}
              />
            </Animated.View>
          ) : null}

          {/* przyciemnienie poza oknem kadru (4 pasy) */}
          {area > 0 ? (
            <>
              <View pointerEvents="none" style={{ ...dim, left: 0, right: 0, top: 0, height: win.top }} />
              <View pointerEvents="none" style={{ ...dim, left: 0, right: 0, top: win.top + win.h, bottom: 0 }} />
              <View pointerEvents="none" style={{ ...dim, top: win.top, height: win.h, left: 0, width: win.left }} />
              <View pointerEvents="none" style={{ ...dim, top: win.top, height: win.h, right: 0, width: win.left }} />
              {/* ramka kadru + siatka rule-of-thirds */}
              <View pointerEvents="none" style={{ position: 'absolute', left: win.left, top: win.top, width: win.w, height: win.h, borderWidth: 1, borderColor: stroke }} />
              <View pointerEvents="none" style={{ position: 'absolute', left: win.left + win.w / 3, top: win.top, width: 1, height: win.h, backgroundColor: stroke }} />
              <View pointerEvents="none" style={{ position: 'absolute', left: win.left + (2 * win.w) / 3, top: win.top, width: 1, height: win.h, backgroundColor: stroke }} />
              <View pointerEvents="none" style={{ position: 'absolute', top: win.top + win.h / 3, left: win.left, height: 1, width: win.w, backgroundColor: stroke }} />
              <View pointerEvents="none" style={{ position: 'absolute', top: win.top + (2 * win.h) / 3, left: win.left, height: 1, width: win.w, backgroundColor: stroke }} />
            </>
          ) : null}
        </View>
      </View>

      {/* STEROWANIE (dwustopniowe): aktywny panel podświetlony. Tap w panel = fokus + akcja. */}
      <View style={{ gap: 12, alignSelf: 'stretch' }}>
        <RotationDial
          angle={angle}
          active={focus === 'rotation'}
          onDelta={(delta) => { if (focus !== 'rotation') setFocus('rotation'); setAngleClamped(angleRef.current + delta); }}
        />
        <AspectBar index={aspectIdx} active={focus === 'ratio'} onPick={(i) => { setFocus('ratio'); setAspectIdx(i); }} />
      </View>
    </View>
  );
});
