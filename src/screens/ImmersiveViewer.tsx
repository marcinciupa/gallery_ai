/**
 * ImmersiveViewer — pełnoekranowe, „prawdziwe" przeglądanie zdjęć (Figma _AI 450:1516). Renderowane w ROOCIE
 * aplikacji NAD obudową (DeviceShell), na czystej czerni #000000 — BEZ matrycy, filtrów i beveli ekranu.
 *
 * Wejście: press joysticka albo pinch-out w viewerze w ramce → obraz na całą szerokość ekranu telefonu.
 * Gesty (jeden PanResponder, transformacje na wątku natywnym — useNativeDriver; bez re-renderów w trakcie gestu):
 *   • pinch          → zoom 100%–MAX (fit szerokości = 100%),
 *   • 1 palec @ zoom  → pan powiększonego obrazu (klamrowany do jego krawędzi),
 *   • 1 palec @ 100%  → swipe zmiany zdjęcia (pager 3 slotów: prev/current/next),
 *   • swipe-up        → pokaż info: obszar obrazu kurczy się (contain → pełna szerokość) i panel INFO wjeżdża POD
 *                       spodem (Figma 450:1516); swipe-down = schowaj info, a gdy info schowane → ZAMKNIJ widok;
 *                       tap NIE pokazuje info; tap w pas CLOSE (gdy info) = wyjście,
 *   • pinch-in ponizej 100% → WYJŚCIE. „Dwa poziomy" wychodzą JEDNĄ regułą: puszczenie pod progiem zamyka,
 *     wolny pinch z 200% zwalnia i zaczepia na 100% (poziom 1), kolejny/mocniejszy pinch schodzi pod próg i
 *     zamyka (poziom 2). Szybki mocny pinch przelatuje pod próg od razu → zamyka bez zatrzymania na 100%.
 *
 * Wydajność: montujemy tylko current ±1 (okienkowanie), nie cały feed. Zoom/pan/swipe = Animated.Value.setValue
 * (nie setState) → zero re-renderów w trakcie ruchu. Re-render tylko na zmianę zdjęcia i puszczenie gestu (zoom%).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Animated, PanResponder, BackHandler, StatusBar,
  ImageSourcePropType,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { dims, font, screen, textShadow } from '../theme/tokens';
import { InfoPanel, type ImageInfo } from './EditorScreen';
import { hapticTap, hapticZoomIn, hapticZoomOut } from '../lib/haptics';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

const MAX = 2;             // maksymalny zoom = 200% (fit szerokości/ekranu = 1.0 = 100%)
const CLOSE_FLOOR = 0.4;   // wizualny dolny limit przy „pull-to-close" (obraz jeszcze się kurczy pod fit)
const CLOSE_TRIGGER = 0.55; // puszczenie ze skalą poniżej tego progu → wyjście; 0.55..1.0 „zaczepia" na 100% (trudniej zamknąć)
const PINCH_DEAD = 14;     // dead-zone pinch (px): mikroruchy dwoma palcami nie zmieniają zoomu (wartość pośrednia)
const CLOSE_BAND = 104;    // dolny pas ekranu, gdzie tap = CLOSE (gdy info widoczne)
const TAP_MOVE = 12;       // maks. ruch (px), by gest liczył się jako tap
const TAP_MS = 260;        // maks. czas (ms) tapa
const SWIPE_TH = 50;       // próg pionowego swipe (px): w górę = pokaż info, w dół = schowaj
const INFO_H = 280;        // wysokość dolnego obszaru INFO (panel danych + CLOSE); o tyle obraz jedzie w górę i się kurczy

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// nazwa pliku w górnym pasku; gdy za długa → prefix + „~" + 3 ostatnie znaki bazy + rozszerzenie (np. „moondsad~145.jpg").
function truncName(name?: string | null, max = 22): string {
  if (!name) return '';
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const tail = base.slice(-3);
  const budget = Math.max(1, max - 1 - tail.length - ext.length); // miejsce na prefix po odjęciu „~" + tail + ext
  return `${base.slice(0, budget)}~${tail}${ext}`;
}
// „contain": rozmiar obrazu (ratio = w/h) wpisany w prostokąt WxH z zachowaniem proporcji
function containFit(W: number, H: number, ratio: number) {
  return W / H > ratio ? { w: H * ratio, h: H } : { w: W, h: W / ratio };
}

export function ImmersiveViewer({
  photos, index, setIndex, onClose, info, statusBarH,
}: {
  photos: ImageSourcePropType[];
  index: number;
  setIndex: (i: number) => void;
  onClose: () => void;
  info: ImageInfo; // ten sam panel/dane co podgląd w ramce — dziedziczy stan otwarcia i pokazuje realne wartości
  statusBarH?: number; // realna wysokość status bara telefonu (App: RNStatusBar.currentHeight) → wysokość górnego paska info_area
}) {
  // info_area = wysokość status bara TELEFONU (dynamicznie); fallback = token design systemu (czoło obudowy = 40)
  const TOP_BAR_H = statusBarH && statusBarH > 0 ? statusBarH : dims.statusBarHeight;
  // rozmiar mierzymy z WŁASNEGO layoutu (nie useWindowDimensions) — nakładka bleeduje poza insety obudowy,
  // więc jej realny rozmiar = pełny fizyczny ekran; dzięki temu obraz jest wyśrodkowany dokładnie na ekranie.
  const [size, setSize] = useState({ W: 0, H: 0 });
  const W = size.W, H = size.H;
  const ready = W > 0 && H > 0;
  const n = photos.length;
  const [zoomPct, setZoomPct] = useState(100);
  const [centerRatio, setCenterRatio] = useState<number | null>(null);

  // wejście = miękki haptyczny impuls (zoom-in) + UKRYCIE status bara (prawdziwy fullscreen). Android back
  // zamyka immersive (nie apkę). Na wyjściu przywracamy status bar.
  useEffect(() => {
    hapticZoomIn();
    StatusBar.setHidden(true, 'fade');
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onCloseRef.current(); return true; });
    return () => { sub.remove(); StatusBar.setHidden(false, 'fade'); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animated (native driver): translateX paska (pager) + scale/translate środkowego obrazu
  const pageX = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const infoV = useRef(new Animated.Value(0)).current; // 0 = tylko obraz (full), 1 = panel info widoczny (translate/opacity paska+panelu)
  const imgHV = useRef(new Animated.Value(0)).current;  // animowana WYSOKOŚĆ obszaru obrazu (obraz `contain` → zawsze pełna szerokość)
  const imgTopV = useRef(new Animated.Value(0)).current; // animowany TOP obszaru obrazu: 0 ↔ TOP_BAR_H (przy INFO obraz pod górnym paskiem)
  // lustrzane wartości numeryczne + bookkeeping gestu (czytane w PanResponderze bez re-tworzenia go)
  const cur = useRef({ s: 1, x: 0, y: 0 });
  const base = useRef({ s: 1, x: 0, y: 0 });
  const pageNum = useRef(0);
  const pinch = useRef<{ d0: number; s0: number; active: boolean } | null>(null);
  const didPinch = useRef(false);
  const moved = useRef(false);
  const startT = useRef(0);
  // refy na wartości zmienne w czasie (PanResponder tworzony raz)
  const env = useRef({ W, H, index, n, ratio: null as number | null, open: false, setOpen: (_v: boolean) => {} });
  const onCloseRef = useRef(onClose);
  const setIndexRef = useRef(setIndex);
  useEffect(() => { env.current = { W, H, index, n, ratio: centerRatio, open: info.open, setOpen: info.setOpen }; onCloseRef.current = onClose; setIndexRef.current = setIndex; });

  // zmiana zdjęcia / obrót ekranu → pasek w pozycji spoczynkowej (-index*W) i wyzerowany zoom.
  // Sloty pozycjonowane ABSOLUTNIE po indeksie zdjęcia (left = i*W) i kluczowane indeksem — środkowy obraz to
  // wciąż TEN SAM komponent (bez podmiany source → bez przeładowania/mignięcia), a pozycja spoczynkowa po animacji
  // paginacji = -(index)*W (bez skoku re-centrowania).
  useLayoutEffect(() => {
    pageNum.current = -index * W; pageX.setValue(-index * W);
    cur.current = { s: 1, x: 0, y: 0 }; base.current = { s: 1, x: 0, y: 0 };
    scale.setValue(1); tx.setValue(0); ty.setValue(0);
    imgHV.setValue(W > 0 && H > 0 ? (info.open ? H - INFO_H - TOP_BAR_H : H) : 0); // sync wysokości obrazu na zmianę rozmiaru (bez animacji)
    imgTopV.setValue(info.open ? TOP_BAR_H : 0);
    setZoomPct(100); setCenterRatio(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, W, H]);

  // pokazanie/schowanie INFO: obraz jedzie w górę i kurczy się, panel wjeżdża pod spodem (jak w podglądzie w ramce).
  // Pokazanie info wraca do fit (czysty układ „obraz na górze"). Native driver → płynnie.
  useEffect(() => {
    Animated.timing(infoV, { toValue: info.open ? 1 : 0, duration: 240, useNativeDriver: true }).start();
    Animated.timing(imgHV, { toValue: info.open ? H - INFO_H - TOP_BAR_H : H, duration: 240, useNativeDriver: false }).start();
    Animated.timing(imgTopV, { toValue: info.open ? TOP_BAR_H : 0, duration: 240, useNativeDriver: false }).start();
    if (info.open) {
      cur.current = { s: 1, x: 0, y: 0 }; base.current = { s: 1, x: 0, y: 0 };
      setZoomPct(100);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.spring(tx, { toValue: 0, useNativeDriver: true }),
        Animated.spring(ty, { toValue: 0, useNativeDriver: true }),
      ]).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.open]);

  const dist2 = (ts: any[]) => Math.hypot(ts[0].pageX - ts[1].pageX, ts[0].pageY - ts[1].pageY);
  const panBounds = () => {
    const { W: w, H: hh, ratio, open } = env.current;
    const h = open ? hh - INFO_H - TOP_BAR_H : hh; // obraz mieści się w obszarze o wysokości imgH (przy INFO pod górnym paskiem)
    const fit = containFit(w, h, ratio ?? w / h);
    return { x: Math.max(0, (fit.w * cur.current.s - w) / 2), y: Math.max(0, (fit.h * cur.current.s - h) / 2) };
  };
  const doClose = () => { hapticZoomOut(); onCloseRef.current(); };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (_e, _g) => {
      base.current = { ...cur.current };
      pinch.current = null; didPinch.current = false; moved.current = false;
      startT.current = Date.now();
    },
    onPanResponderMove: (e, g) => {
      const ts = e.nativeEvent.touches;
      const { W: w, index: idx, n: cnt } = env.current;
      if (ts.length >= 2) {
        didPinch.current = true;
        const d = dist2(ts);
        if (!pinch.current) pinch.current = { d0: d, s0: base.current.s, active: false };
        // dead-zone: dopóki palce nie ruszą się o PINCH_DEAD, nie skalujemy (tłumi mikroruchy). Po przekroczeniu
        // re-kotwiczymy d0 do bieżącego rozstawu, żeby zoom ruszył płynnie (bez skoku o wielkość dead-zone).
        if (!pinch.current.active) {
          if (Math.abs(d - pinch.current.d0) < PINCH_DEAD) return;
          pinch.current.active = true; pinch.current.d0 = d;
          if (env.current.open) env.current.setOpen(false); // zoom (pinch) zamyka info
        }
        moved.current = true;
        const raw = pinch.current.s0 * (d / pinch.current.d0);
        const s = clamp(raw, CLOSE_FLOOR, MAX);
        cur.current.s = s; scale.setValue(s);
      } else if (ts.length === 1 && base.current.s > 1.01) {
        // pan powiększonego obrazu (klamrowany do krawędzi)
        moved.current = true;
        const b = panBounds();
        cur.current.x = clamp(base.current.x + g.dx, -b.x, b.x);
        cur.current.y = clamp(base.current.y + g.dy, -b.y, b.y);
        tx.setValue(cur.current.x); ty.setValue(cur.current.y);
      } else if (ts.length === 1) {
        // paging: przeciąganie paska; opór na krańcach (brak prev/next)
        if (Math.abs(g.dx) > TAP_MOVE || Math.abs(g.dy) > TAP_MOVE) moved.current = true;
        let dx = g.dx;
        if (idx <= 0 && dx > 0) dx *= 0.3;
        if (idx >= cnt - 1 && dx < 0) dx *= 0.3;
        pageNum.current = -idx * w + dx; pageX.setValue(pageNum.current);
      }
    },
    onPanResponderRelease: (_e, g) => {
      const { W: w, H: h, index: idx, n: cnt } = env.current;
      const wasPinch = didPinch.current;
      pinch.current = null; didPinch.current = false;
      if (wasPinch) {
        if (cur.current.s < CLOSE_TRIGGER) { doClose(); return; }
        const ns = clamp(cur.current.s, 1, MAX);
        cur.current.s = ns; base.current.s = ns;
        setZoomPct(Math.round(ns * 100));
        const anims = [Animated.spring(scale, { toValue: ns, useNativeDriver: true })];
        if (ns <= 1.01) {
          cur.current.x = 0; cur.current.y = 0; base.current.x = 0; base.current.y = 0;
          anims.push(Animated.spring(tx, { toValue: 0, useNativeDriver: true }), Animated.spring(ty, { toValue: 0, useNativeDriver: true }));
        }
        Animated.parallel(anims).start();
        base.current = { ...cur.current };
        return;
      }
      if (base.current.s > 1.01) { base.current = { ...cur.current }; return; } // był pan zoomu
      // tap vs swipe (przy 100%)
      const dt = Date.now() - startT.current;
      if (!moved.current && dt < TAP_MS && Math.abs(g.dx) < TAP_MOVE && Math.abs(g.dy) < TAP_MOVE) {
        // tap NIE pokazuje info (do tego jest swipe); tap w pas CLOSE przy widocznym info = wyjście
        if (env.current.open && g.y0 > h - CLOSE_BAND) doClose();
        Animated.spring(pageX, { toValue: -idx * w, useNativeDriver: false }).start();
        pageNum.current = -idx * w;
        return;
      }
      // pionowy swipe (przy 100% — zoom łapie gest wcześniej). W górę = pokaż info. W dół = schowaj info,
      // a gdy info już schowane → ZAMKNIJ real fullscreen (dwustopniowo: najpierw info, potem widok).
      if (Math.abs(g.dy) > Math.abs(g.dx) && Math.abs(g.dy) > SWIPE_TH) {
        if (g.dy < 0) { if (!env.current.open) { hapticTap(); env.current.setOpen(true); } }
        else if (env.current.open) { hapticTap(); env.current.setOpen(false); }
        else { doClose(); return; } // swipe-down przy schowanym info → wyjście z widoku
        Animated.spring(pageX, { toValue: -idx * w, useNativeDriver: false }).start();
        pageNum.current = -idx * w;
        return;
      }
      // paginacja: animujemy pasek do pozycji SĄSIADA (-(idx±1)*w) i dopiero potem zmieniamy index; pozycja
      // spoczynkowa nowego indeksu = koniec animacji → brak skoku re-centrowania (i brak podmiany source środka).
      const TH = w * 0.22;
      if (g.dx < -TH && idx < cnt - 1) {
        Animated.timing(pageX, { toValue: -(idx + 1) * w, duration: 180, useNativeDriver: false }).start(() => setIndexRef.current(idx + 1));
      } else if (g.dx > TH && idx > 0) {
        Animated.timing(pageX, { toValue: -(idx - 1) * w, duration: 180, useNativeDriver: false }).start(() => setIndexRef.current(idx - 1));
      } else {
        Animated.spring(pageX, { toValue: -idx * w, useNativeDriver: false }).start();
        pageNum.current = -idx * w;
      }
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // trzy sloty: [prev, current, next] — tylko istniejące zdjęcia
  const slots = [index - 1, index, index + 1];
  const cap = { fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.primary, ...phosphorGlow } as const;
  const val = { fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: screen.olive.primary, ...phosphorGlow } as const;
  // panel INFO wjeżdża od dołu (translateY INFO_H→0) + opacity; wysokość obrazu (imgHV) kurczy się osobno,
  // dzięki czemu obraz `contain` zawsze wypełnia PEŁNĄ szerokość (bez czarnych pasów po bokach dla landscape).
  const infoTY = infoV.interpolate({ inputRange: [0, 1], outputRange: [INFO_H, 0] });

  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000000', overflow: 'hidden' }}
      onLayout={(e) => { const { width, height } = e.nativeEvent.layout; setSize((s) => (Math.abs(s.W - width) < 1 && Math.abs(s.H - height) < 1 ? s : { W: width, H: height })); }}
      {...responder.panHandlers}
    >
      {ready ? (
      <>
        {/* OBRAZ — pasek 3 slotów (pager, translateX). Wysokość slotu = imgHV (kurczy się gdy INFO), top:0 →
            obraz siedzi u góry; contain w W×imgHV → landscape zawsze na PEŁNĄ szerokość. */}
        <Animated.View style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, transform: [{ translateX: pageX }] }}>
          {slots.map((si) => {
            const src = photos[si];
            // pozycja i KLUCZ po indeksie zdjęcia (si) — nie po pozycji slotu; ten sam obraz = ten sam komponent
            // między zmianami index (bez podmiany source → bez przeładowania/mignięcia).
            if (!src) return <View key={si} style={{ position: 'absolute', left: si * W, top: 0, width: W }} />;
            const isCenter = si === index;
            const img = (
              <ExpoImage
                source={src}
                contentFit="contain"
                cachePolicy="memory-disk"
                onLoad={isCenter ? (ev: any) => { const s = ev?.source; if (s?.width && s?.height) setCenterRatio(s.width / s.height); } : undefined}
                style={{ width: '100%', height: '100%' }}
              />
            );
            return (
              // JEDNOLITA struktura każdego slotu (outer + inner Animated.View) — transform zoomu tylko dla środka.
              // Zmienia się sam `transform` (prop), a NIE struktura → ExpoImage nie remountuje przy przejściu
              // sąsiad↔środek → brak przeładowania obrazu i mignięcia po swipie.
              <Animated.View key={si} style={{ position: 'absolute', left: si * W, top: imgTopV, width: W, height: imgHV }}>
                <Animated.View style={{ width: '100%', height: '100%', transform: isCenter ? [{ translateX: tx }, { translateY: ty }, { scale }] : undefined }}>{img}</Animated.View>
              </Animated.View>
            );
          })}
        </Animated.View>

        {/* górny pasek info_area (Figma: height 40, padding 8/16) — [ZOOM 100%] [nazwa — środek] [FILE x/n]; pojawia się z INFO */}
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: W, height: TOP_BAR_H, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 16, opacity: infoV }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Text style={cap}>ZOOM</Text><Text style={val}>{zoomPct}%</Text></View>
          <Text numberOfLines={1} style={{ ...val, flex: 1, textAlign: 'center' }}>{truncName(info.filename)}</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Text style={cap}>FILE</Text><Text style={val}>{index + 1}/{n}</Text></View>
        </Animated.View>

        {/* dolny obszar INFO — wjeżdża POD obraz (translateY) i pojawia się (opacity): TEN SAM InfoPanel + CLOSE */}
        <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: INFO_H, transform: [{ translateY: infoTY }], opacity: infoV }}>
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <InfoPanel dims={info.dims} fileSize={info.fileSize} format={info.format} aiTools={info.aiTools} aiPrompt={info.aiPrompt} aiUpscale={info.aiUpscale} prov={info.prov} />
          </View>
          <View style={{ flex: 1 }} />
          <View style={{ height: CLOSE_BAND, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: font.monoBody.family, fontSize: 20, color: screen.olive.primary, ...phosphorGlow }}>CLOSE</Text>
          </View>
        </Animated.View>
      </>
      ) : null}
    </View>
  );
}
