/**
 * EditorScreen — pełnoekranowy podgląd + edycja pojedynczego zdjęcia (Figma „fullscreen_view/edit").
 * Zastępuje treść ekranu, gdy w galerii otwarty jest podgląd (`viewerOpen`). Trzy pod-widoki:
 *   • VIEWER — czysty obraz w polu treści (pinch-zoom), pasek statusu z etykietą VIEWER.
 *   • CROP   — kadrowanie i rotacja (Etap 2; na razie placeholder).
 *   • AI     — edycja promptem przez deAPI/z-image (Etap 3; na razie placeholder).
 *
 * Menu EDIT (popover, jak menu galerii): AI EDIT / CROP & ROTATE — wybór pod-widoku.
 * Klawiatura kontekstowa per pod-widok. `goBack` domyka kolejno: menu → pod-widok → (false = zamknij podgląd).
 */
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Animated, PanResponder, Image as RNImage, ImageSourcePropType, LayoutChangeEvent, TextInput, Keyboard as RNKeyboard } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { color, font, screen, textShadow } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';
import { MenuBar } from '../components/chrome/MenuBar';
import { ScreenTopBar, AiStatusView } from './ScreenChrome';
import { CropStage, CropHandle } from './CropStage';
import { VideoStage, type VideoStageHandle } from './VideoStage';
import { formatDuration } from '../lib/duration';
import { MagicEraseStage, MagicEraseHandle, MagicEraseState } from './MagicEraseStage';
import { AiStage, AiStageHandle } from './AiStage';
import { editImage, fillImage, boostPrompt, upscaleImage } from '../lib/deapi';
import { saveImageToLibrary } from '../lib/saveImage';
import { getProvenance, getFileBytes, isAiSource, type Provenance, type SourceType } from '../lib/imageMeta';
import { ensureLocalFile, persistWorkFile } from '../lib/localFile';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

type EditView = 'viewer' | 'crop' | 'ai' | 'magicErase';

// menu EDIT — dwupoziomowy pasek (Figma _AI 402:5258):
//   • PASEK GŁÓWNY (zakładki trybu): AI EDIT / CROP & ROTATE
//   • POD-PASEK (funkcje AI, tylko gdy AI EDIT): MAGIC ERASE / TEXT TO IMAGE / FILTERS
const MAIN_TABS = ['AI EDIT', 'CROP & ROTATE'] as const;
const AI_FUNCS = ['MAGIC ERASE', 'TEXT TO IMAGE', 'UPSCALE', 'FILTERS'] as const;
const AI_TEXT2IMG = 1; // TEXT TO IMAGE (prompt edit)
const AI_UPSCALE = 2;  // UPSCALE (jednoklik, RealESRGAN x4). FILTERS (3) = wciąż stub „SOON".

const PILL = { boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as const;

const AI_MODEL = 'DEAPI · Z-IMAGE'; // model stojący za edycjami AI (deAPI / z-image)

/**
 * InfoPanel — parametry obrazka (Figma _AI 426:7051) + „ślad" AI. Fosforowe pary etykieta/wartość w 2 kolumnach.
 * Dane: wymiary/rozdzielczość z realnie wczytanego obrazu; FILE SIZE = „—" (brak expo-file-system, dojdzie później).
 * Sekcja AI mówi WPROST o ingerencji AI: czy edytowano, jakimi narzędziami, jakim modelem i z jakim promptem.
 */
export function InfoField({ cap, val, grow }: { cap: string; val: string; grow?: boolean }) {
  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ fontFamily: font.monoBody.family, fontSize: 10, color: screen.olive.primary, ...phosphorGlow }}>{cap}</Text>
      <Text numberOfLines={grow ? 2 : 1} style={{ flex: grow ? 1 : undefined, fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: screen.olive.primary, ...phosphorGlow }}>{val}</Text>
    </View>
  );
}
const sourceLabel = (t: SourceType): string => (t === 'ai' ? 'AI GENERATED' : t === 'aiComposite' ? 'AI COMPOSITE' : t === 'capture' ? 'CAMERA' : '—');
export const formatBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : n >= 1e3 ? `${Math.round(n / 1e3)}KB` : `${n}B`);
// FORMAT do panelu INFO: rzeczywisty format z rozszerzenia pliku; RAW jako np. „.dng (RAW)".
export function formatLabel(filename?: string | null, raw?: boolean): string | null {
  const ext = filename?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!ext) return raw ? 'RAW' : null;
  return raw ? `.${ext} (RAW)` : ext.toUpperCase();
}

/**
 * Nazwa pliku pod obrazem. Limit 40 znaków dobrany pod PEŁNĄ szerokość treści — nazwa nie siedzi już w
 * ciasnym górnym pasku, więc typowe `IMG_20260803_073104.jpg` (23 znaki) mieści się w całości i nic nie jest
 * skracane. Dopiero naprawdę długie nazwy tracą ŚRODEK (prefix + „~" + 3 ostatnie znaki bazy + rozszerzenie),
 * bo rozszerzenie i końcówka niosą więcej informacji niż sam początek.
 */
export function truncName(name?: string | null, max = 40): string {
  if (!name) return '';
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const tail = base.slice(-3);
  const budget = Math.max(1, max - 1 - tail.length - ext.length);
  return `${base.slice(0, budget)}~${tail}${ext}`;
}

// Dane panelu INFO — wyliczone raz w useImageEditor, współdzielone z podglądem w ramce ORAZ z immersive (ten sam panel).
export type ImageInfo = {
  open: boolean;
  setOpen: (v: boolean) => void;
  dims: { w: number; h: number } | null;
  fileSize: string | null;
  format: string | null;
  filename: string | null;
  aiTools: string[];
  aiPrompt: string | null;
  aiUpscale: number | null;
  prov: Provenance | null;
  place?: string | null;
  duration?: number | null; // wideo: długość w ms (MediaStore) — patrz lib/duration
};

export function InfoPanel({ dims, fileSize, format, aiTools, aiPrompt, aiUpscale, prov, place, duration }: { dims: { w: number; h: number } | null; fileSize: string | null; format?: string | null; aiTools: string[]; aiPrompt: string | null; aiUpscale: number | null; prov: Provenance | null; place?: string | null; duration?: number | null }) {
  const mp = dims ? Math.ceil((dims.w * dims.h) / 1e5) / 10 : null; // megapiksele; zaokrąglenie W GÓRĘ do 0.1 (stabilne, bez migania)
  // SOURCE/C2PA = odczyt ze standardów (IPTC digitalSourceType + obecność Content Credentials) z oryginału.
  // FORMAT = rzeczywisty format z rozszerzenia (RAW → np. „.dng (RAW)"). AI EDITED = ingerencja AI (metadane lub edycja).
  const edited = aiTools.length > 0 || isAiSource(prov?.sourceType ?? null);
  const rows: [string, string][][] = [
    [['RESOLUTION', mp != null ? `${mp}MP` : '—'], ['FILE SIZE', fileSize ?? '—']],
    [['WIDTH', dims ? `${dims.w}px` : '—'], ['HEIGHT', dims ? `${dims.h}px` : '—']],
    [['FORMAT', format ?? '—'], ['C2PA', prov?.hasC2PA ? 'YES' : 'NO']],
    [['SOURCE', sourceLabel(prov?.sourceType ?? null)], ['AI EDITED', edited ? 'YES' : 'NO']],
    [['AI UPSCALE', aiUpscale ? `YES (${aiUpscale}X)` : 'NO']],
  ];
  // WIDEO: długość zamiast pola AI UPSCALE (filmów nie skalujemy AI) — wstawiana zaraz pod formatem.
  const len = formatDuration(duration);
  if (len) rows.splice(3, 0, [['LENGTH', len]]);
  return (
    <View style={{ alignSelf: 'stretch', gap: 8 }}>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', alignSelf: 'stretch', gap: 24 }}>
          {r.map(([c, v], j) => <InfoField key={j} cap={c} val={v} />)}
        </View>
      ))}
      {edited ? <View style={{ flexDirection: 'row', alignSelf: 'stretch' }}><InfoField cap="AI MODEL" val={AI_MODEL} grow /></View> : null}
      {edited ? <View style={{ flexDirection: 'row', alignSelf: 'stretch' }}><InfoField cap="AI TOOLS" val={aiTools.join(', ')} grow /></View> : null}
      {aiPrompt ? <View style={{ flexDirection: 'row', alignSelf: 'stretch' }}><InfoField cap="AI PROMPT" val={`"${aiPrompt}"`} grow /></View> : null}
      {place ? <View style={{ flexDirection: 'row', alignSelf: 'stretch' }}><InfoField cap="LOCATION" val={place} grow /></View> : null}
    </View>
  );
}

/**
 * Pinch-zoom podglądu (1×–6×), 1 palcem przesuwanie gdy powiększone; puszczenie poniżej 1× wraca do
 * dopasowania. Przy 100% poziomy gest przesuwa obraz za palcem i zmienia zdjęcie (droga LUB flick).
 * Gesty na PanResponderze (brak gesture-handlera w projekcie). Zmiana zdjęcia NIE remountuje komponentu
 * (to przeładowywało obraz przy każdym swipie) — zoom zeruje efekt na `source`.
 * Renderowany W POLU TREŚCI (nie fullscreen) — pasek statusu nad nim zostaje widoczny.
 */
function ZoomImage({ source, prevSource, nextSource, onPrev, onNext, onSwipeUp, onSwipeDown, onDims, onImmersive, onExit }: { source: ImageSourcePropType; prevSource?: ImageSourcePropType; nextSource?: ImageSourcePropType; onPrev?: () => void; onNext?: () => void; onSwipeUp?: () => void; onSwipeDown?: () => void; onDims?: (w: number, h: number) => void; onImmersive?: () => void; onExit?: () => void }) {
  const immersedRef = useRef(false); // gest ZUŻYTY (pinch-out → immersive, pinch-in → wyjście) — jednorazowo na gest
  const initRatio = useMemo(() => {
    // Wymiary z METADANYCH źródła (mediaWidth/mediaHeight) — znane OD RAZU, więc dopasowanie jest poprawne
    // przy pierwszej klatce. Wcześniej brano je z resolveAssetSource, które dla content:// URI zwraca puste
    // → ratio=1 (kwadrat) → obraz błyskał w złym rozmiarze, aż onLoad podał realne proporcje.
    const mw = (source as any)?.mediaWidth, mh = (source as any)?.mediaHeight;
    if (mw && mh) return mw / mh;
    try { const a = RNImage.resolveAssetSource(source as any); return a?.width && a?.height ? a.width / a.height : 1; } catch { return 1; }
  }, [source]);
  const [ratio, setRatio] = useState(initRatio); // szer/wys
  const [box, setBox] = useState({ w: 0, h: 0 });
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  // PAGER jak w IMMERSIVE: trzy sloty [prev · current · next] obok siebie, przesuwane jednym translateX.
  // Wcześniej jechał sam obraz i po puszczeniu wracał sprężyną — stąd „efekt procy". Tu gest przesuwa CAŁY
  // pasek, a zmiana zdjęcia to dojechanie do sąsiada; po podmianie źródła pasek wraca na 0 bez mrugnięcia.
  const pageX = useRef(new Animated.Value(0)).current;
  const paging = useRef(false); // trwa animacja dojazdu → ignoruj kolejne gesty
  const cur = useRef({ s: 1, x: 0, y: 0 });
  const base = useRef({ s: 1, x: 0, y: 0 });
  const pinch = useRef<{ d0: number; s0: number } | null>(null);
  const didPinch = useRef(false); // czy w geście były 2 palce → to nie swipe zmiany zdjęcia
  const dragging = useRef(false); // trwa poziomy swipe przy 100% (obraz podąża za palcem)
  const SWIPE_V = 60;             // próg PIONOWEGO swipe (px): góra = INFO, dół = schowaj INFO
  // Próg POZIOMY: ułamek szerokości pola (nie sztywne 60 px) + próg PRĘDKOŚCI. Wcześniej trzeba było
  // przeciągnąć 60 px BEZ ŻADNEJ reakcji obrazu, więc krótki, szybki gest nie robił nic i swipe wydawał się
  // „ciężki". Teraz obraz jedzie za palcem, a przełącza go albo droga, albo sam flick.
  const boxRef = useRef({ w: 0, h: 0 });
  const swipeTh = () => Math.max(24, boxRef.current.w * 0.12);
  const FLING = 0.3;              // px/ms — szybki ruch przełącza mimo krótkiej drogi

  // Zmiana ZDJĘCIA nie remountuje już tego komponentu (patrz `key` przy <ZoomImage/>) — remount przeładowywał
  // obraz przy każdym swipie i to była pauza widoczna jako „chrupnięcie". Zamiast tego zerujemy stan gestu
  // tutaj: proporcje z metadanych nowego pliku + zoom/pan na start.
  useEffect(() => {
    setRatio(initRatio);
    cur.current = { s: 1, x: 0, y: 0 };
    base.current = { s: 1, x: 0, y: 0 };
    // stopAnimation PRZED setValue — inaczej trwająca sprężyna nadpisze zerowanie i obraz zostanie przesunięty
    [scale, tx, ty, pageX].forEach((v) => v.stopAnimation());
    scale.setValue(1); tx.setValue(0); ty.setValue(0);
    pageX.setValue(0); // nowy „current" jest już w środkowym slocie → pasek w pozycji spoczynkowej
    paging.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);


  // PanResponder powstaje RAZ, a od kiedy komponent nie remountuje się przy zmianie zdjęcia, jego domknięcie
  // trzymałoby callbacki z pierwszego renderu — np. `onNext` wyzerowane na czas `processing` nadal by działało.
  // Dlatego handlery czytamy przez ref aktualizowany co render.
  const cb = useRef({ onPrev, onNext, onSwipeUp, onSwipeDown, onImmersive, onExit, prevSource, nextSource });
  cb.current = { onPrev, onNext, onSwipeUp, onSwipeDown, onImmersive, onExit, prevSource, nextSource };

  const dist2 = (ts: any[]) => Math.hypot(ts[0].pageX - ts[1].pageX, ts[0].pageY - ts[1].pageY);
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // nie oddawaj gestu responderowi obudowy (swipe ekranu) — inaczej swipe zmiany zdjęcia „ucieka"
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { base.current = { ...cur.current }; pinch.current = null; didPinch.current = false; dragging.current = false; immersedRef.current = false; },
      onPanResponderMove: (e, g) => {
        const ts = e.nativeEvent.touches;
        if (ts.length >= 2) {
          didPinch.current = true;
          const d = dist2(ts);
          if (!pinch.current) pinch.current = { d0: d, s0: base.current.s };
          const ratioG = d / pinch.current.d0;
          if (cb.current.onImmersive) {
            // W ramce pinch NIE zoomuje w polu — służy do przejść:
            //  • pinch-OUT (rozsunięcie, skala > 1.25 i > 55 px) → IMMERSIVE,
            //  • pinch-IN (zsunięcie, skala < 0.55 i > 55 px) → wyjście do FEED/FOLDERS (parametry jak wyjście z immersive).
            if (!immersedRef.current && pinch.current.s0 * ratioG > 1.25 && d - pinch.current.d0 > 55) {
              immersedRef.current = true; cb.current.onImmersive();
            } else if (!immersedRef.current && cb.current.onExit && pinch.current.s0 * ratioG < 0.55 && pinch.current.d0 - d > 55) {
              immersedRef.current = true; cb.current.onExit();
            }
            return;
          }
          const s = clamp(pinch.current.s0 * ratioG, 1, 6);
          cur.current.s = s;
          scale.setValue(s);
        } else if (ts.length === 1 && base.current.s > 1) {
          cur.current.x = base.current.x + g.dx;
          cur.current.y = base.current.y + g.dy;
          tx.setValue(cur.current.x);
          ty.setValue(cur.current.y);
        } else if (ts.length === 1 && !didPinch.current && !paging.current) {
          // 100% → PASEK podąża za palcem (sam `setValue`, bez setState → zero re-renderów). Ruch w pionie
          // zostaje dla swipe'u INFO, więc jedziemy dopiero, gdy gest jest wyraźnie poziomy.
          if (!dragging.current && Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy)) dragging.current = true;
          if (!dragging.current) return;
          // opór na krańcach: brak sąsiada → pasek ustępuje tylko trochę (tak samo jak w IMMERSIVE)
          let dx = g.dx;
          if (dx > 0 && !cb.current.prevSource) dx *= 0.3;
          if (dx < 0 && !cb.current.nextSource) dx *= 0.3;
          pageX.setValue(dx);
        }
      },
      onPanResponderRelease: (_e, g) => {
        const wasPinch = didPinch.current;
        pinch.current = null;
        didPinch.current = false;
        if (cur.current.s <= 1.01) {
          // brak zoomu → swipe: poziomo = zmiana zdjęcia (lewo=następne, prawo=poprzednie); pionowo = INFO (góra=pokaż, dół=schowaj)
          const ax = Math.abs(g.dx), ay = Math.abs(g.dy);
          const horiz = ax > ay * 1.2 && (ax > swipeTh() || Math.abs(g.vx) > FLING);
          const w = boxRef.current.w || 1;
          const goNext = !wasPinch && horiz && g.dx < 0 && !!cb.current.nextSource;
          const goPrev = !wasPinch && horiz && g.dx > 0 && !!cb.current.prevSource;
          if (!wasPinch && !horiz && ay > SWIPE_V && ay > ax * 1.2) {
            if (g.dy < 0) cb.current.onSwipeUp?.(); else cb.current.onSwipeDown?.();
          }
          dragging.current = false;
          cur.current = { s: 1, x: 0, y: 0 };
          base.current = { s: 1, x: 0, y: 0 };
          if (goNext || goPrev) {
            // DOJAZD do sąsiada, potem podmiana zdjęcia — dokładnie jak pager w IMMERSIVE. Pasek wraca na 0
            // dopiero wtedy, gdy nowy „current" jest już w środkowym slocie, więc nic nie przeskakuje.
            paging.current = true;
            Animated.timing(pageX, { toValue: goNext ? -w : w, duration: 180, useNativeDriver: true }).start(() => {
              if (goNext) cb.current.onNext?.(); else cb.current.onPrev?.();
            });
          } else {
            Animated.parallel([
              Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
              Animated.spring(tx, { toValue: 0, useNativeDriver: true }),
              Animated.spring(ty, { toValue: 0, useNativeDriver: true }),
              Animated.spring(pageX, { toValue: 0, useNativeDriver: true }),
            ]).start();
          }
        } else {
          base.current = { ...cur.current };
        }
      },
    }),
  ).current;

  // dopasowanie „contain" do pola: bierzemy mniejszy z wymiarów (szer wg ratio, wys wg pola)
  const fitFor = (r: number) =>
    box.w > 0 && box.h > 0
      ? (box.w / box.h > r ? { width: box.h * r, height: box.h } : { width: box.w, height: box.w / r })
      : { width: 0, height: 0 };
  const fit = fitFor(ratio);
  // sąsiedzi: proporcje z METADANYCH źródła — są znane od razu, więc slot nie musi czekać na `onLoad`
  const fitOf = (src: ImageSourcePropType) => {
    const mw = (src as any)?.mediaWidth, mh = (src as any)?.mediaHeight;
    return fitFor(mw && mh ? mw / mh : ratio);
  };

  return (
    <View
      style={{ flex: 1, alignSelf: 'stretch', borderRadius: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
      onLayout={(e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        boxRef.current = { w: width, h: height }; // PanResponder czyta rozmiar z refa (tworzony raz, bez re-bindu)
        setBox((b) => (Math.abs(b.w - width) < 1 && Math.abs(b.h - height) < 1 ? b : { w: width, h: height }));
      }}
      {...responder.panHandlers}
    >
      {fit.width > 0 ? (
        // PASEK trzech slotów: [prev · current · next], każdy szerokości pola. Sąsiedzi są zamontowani, więc
        // podczas gestu widać, co nadjeżdża — a nie pustkę i skok jak przy pojedynczym obrazie na sprężynie.
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, width: box.w, height: box.h, transform: [{ translateX: pageX }] }}>
          {([-1, 0, 1] as const).map((off) => {
            const src = off === -1 ? prevSource : off === 0 ? source : nextSource;
            if (!src) return null;
            const f = off === 0 ? fit : fitOf(src);
            const img = (
              <ExpoImage
                source={src}
                contentFit="contain"
                cachePolicy="memory-disk"
                // `onLoad` na KAŻDYM slocie, ale skutkuje tylko dla bieżącego — po przesunięciu pagera ten sam
                // komponent staje się środkowym i drugi raz się nie ładuje, więc handler tylko na off===0 nigdy
                // by dla niego nie zadziałał.
                onLoad={(ev: any) => { if (src !== source) return; const im = ev?.source; if (im?.width && im?.height) { setRatio(im.width / im.height); onDims?.(im.width, im.height); } }}
                style={{ width: f.width, height: f.height }}
              />
            );
            return (
              // KLUCZ = tożsamość zdjęcia, NIE pozycja slotu. Przy kluczu pozycyjnym środkowy slot dostawał po
              // przesunięciu nowe `source`, a expo-image trzyma wtedy starą bitmapę do czasu zdekodowania nowej
              // — stąd mignięcie poprzedniego zdjęcia. Teraz komponent po prostu przesuwa się o slot.
              <View key={String((src as any)?.uri ?? off)} style={{ position: 'absolute', left: off * box.w, top: 0, width: box.w, height: box.h, alignItems: 'center', justifyContent: 'center' }}>
                {off === 0 ? (
                  <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>{img}</Animated.View>
                ) : (
                  img
                )}
              </View>
            );
          })}
        </Animated.View>
      ) : null}
      {/* badge AI / RAW — na zewnętrznym View (nie skaluje się z zoomem obrazu) */}
      {(source as any)?.ai || (source as any)?.raw ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 10, flexDirection: 'row', gap: 8 }}>
          {(source as any)?.ai ? <Text style={viewerBadge}>AI</Text> : null}
          {(source as any)?.raw ? <Text style={viewerBadge}>RAW</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
const viewerBadge = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.primary, textShadowColor: color.dark21, textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } } as const;

export function useImageEditor({
  source,
  prevSource,
  nextSource,
  open,
  place,
  overlay,
  dimmed = false,
  onExit,
  onPrev,
  onNext,
  onCycleMode,
  onOpenSettings,
  onMenu,
  onRequestImmersive,
  leftHanded = false,
  promptBooster = false,
}: {
  source?: ImageSourcePropType;
  prevSource?: ImageSourcePropType; // sąsiedzi do pagera w podglądzie (patrz ZoomImage) — bez nich swipe
  nextSource?: ImageSourcePropType; // pokazywałby pustkę zamiast nadjeżdżającego zdjęcia
  open: boolean;         // podgląd otwarty (galeria: viewerOpen)
  place?: string | null; // nazwa miejsca (GPS→reverseGeocode), rozwiązywana w GalleryScreen
  overlay?: ReactNode;   // nakładka galerii (CONFIRM/wynik) — w OBSZARZE TREŚCI, żeby miała szerokość contentu
  dimmed?: boolean;      // przygaś TREŚĆ podglądu (dialog nad nią) — sama nakładka zostaje w pełnej jasności
  onExit: () => void;    // zamknij podgląd → powrót do siatki
  onPrev: () => void;    // poprzednie zdjęcie
  onNext: () => void;    // następne zdjęcie
  onCycleMode?: () => void; // kliknięcie kafelka trybu → cykl GALLERY/VIEWER/SETTINGS (tylko tryb VIEWER)
  onOpenSettings?: () => void; // menu EDIT → SETTINGS: otwórz ustawienia aplikacji
  onMenu?: () => void;   // klawisz MENU w podglądzie → kontekstowe menu GALERII (domyślna funkcja MENU)
  onRequestImmersive?: () => void; // press joysticka / pinch-out w viewerze → pełnoekranowy IMMERSIVE
  leftHanded?: boolean;  // klawiatura lustrzana (rezerwa — pasek menu jest wyśrodkowany)
  promptBooster?: boolean; // ustawienie EDIT/PROMPT BOOSTER — ulepsz prompt AI przed edycją
}): { content: ReactNode; keyboard: KeyboardConfig; goBack: () => boolean; typing: boolean; info: ImageInfo } {
  const [view, setView] = useState<EditView>('viewer');
  // menu EDIT (dolny dwupoziomowy pasek): otwarcie + fokus poziomu (main=zakładki, sub=funkcje AI) + indeksy.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTier, setMenuTier] = useState<'main' | 'sub'>('main');
  const [mainIdx, setMainIdx] = useState(0); // AI EDIT / CROP & ROTATE / SETTINGS
  const [aiIdx, setAiIdx] = useState(AI_TEXT2IMG); // MAGIC ERASE / TEXT TO IMAGE / FILTERS
  // wynik edycji (crop/AI) trzymany w sesji edytora jako URI; podmienia wyświetlane zdjęcie.
  const [workingUri, setWorkingUri] = useState<string | null>(null);
  const cropRef = useRef<CropHandle>(null);
  const magicRef = useRef<MagicEraseHandle>(null);
  const videoRef = useRef<VideoStageHandle>(null);
  const [videoPlaying, setVideoPlaying] = useState(false); // etykieta klawisza PLAY/PAUSE
  const aiMaskRef = useRef<AiStageHandle>(null); // maska/pędzel w TEXT TO IMAGE (nawigacja joystickiem)
  // stan MAGIC ERASE raportowany przez stage — steruje etykietami klawiszy (APPLY/UNDO/RESET vs SAVE)
  const [magic, setMagic] = useState<MagicEraseState>({ applied: false, hasSelection: false, removeBg: false, processing: false });
  // CROP: czy użytkownik coś zmienił (obrót/kadr/proporcje) → klawiatura SAVE/RESET zamiast samego BACK
  const [cropDirty, setCropDirty] = useState(false);
  // INFO: panel parametrów obrazka (swipe-up / klawisz INFO). Dane + ślad ingerencji AI.
  const [infoOpen, setInfoOpen] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null); // wymiary obrazu do INFO
  const assetDimsRef = useRef(false); // czy `dims` pochodzi już z MediaLibrary (autorytatywne) — wtedy onLoad expo-image ich nie nadpisuje
  const [fileSize, setFileSize] = useState<string | null>(null); // rozmiar pliku (TODO: expo-file-system / EXIF)
  const [aiTools, setAiTools] = useState<string[]>([]); // narzędzia AI użyte w tej sesji (dedup, kolejność)
  const [aiPrompt, setAiPrompt] = useState<string | null>(null); // ostatni prompt TEXT TO IMAGE
  const [aiUpscale, setAiUpscale] = useState<number | null>(null); // krotność upscalu AI (gdy dojdzie feature)
  const [prov, setProv] = useState<Provenance | null>(null); // prowieniencja ORYGINAŁU (IPTC/C2PA)
  const addAiTool = (t: string) => setAiTools((a) => (a.includes(t) ? a : [...a, t]));
  const displaySource: ImageSourcePropType | undefined = workingUri ? { uri: workingUri } : source;
  // WIDEO: podgląd zamiast obrazu, bez edycji. `workingUri` (wynik edycji) jest zawsze obrazem, więc
  // po nim flaga gaśnie — inaczej po zapisie kadru pokazywalibyśmy odtwarzacz dla pliku JPEG.
  const isVideo = !workingUri && !!(source as any)?.video;

  // AI EDIT — pisanie promptu (natywna klawiatura) + przetwarzanie.
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [processing, setProcessing] = useState(false);
  const [procLabel, setProcLabel] = useState('GENERATIVE FILL…'); // etykieta nakładki przetwarzania w viewerze (fill/upscale)
  const [boosting, setBoosting] = useState(false); // trwa ulepszanie promptu (prompt booster) przed edycją
  const [aiError, setAiError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  // TOAST — krótki komunikat (zapis edycji / stub „SOON" / INFO)
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FILL — po kadrze z obrotem zostały puste obszary → propozycja wypełnienia AI
  const [fillOffer, setFillOffer] = useState(false);

  // zamknięcie podglądu → reset do stanu wyjściowego, żeby następne otwarcie zaczynało od VIEWER
  useEffect(() => {
    if (!open) { setView('viewer'); setMenuOpen(false); setMenuTier('main'); setMainIdx(0); setAiIdx(AI_TEXT2IMG); setWorkingUri(null); setTyping(false); setDraft(''); setProcessing(false); setBoosting(false); setAiError(null); setToast(null); setFillOffer(false); setMagic({ applied: false, hasSelection: false, removeBg: false, processing: false }); setCropDirty(false); setInfoOpen(false); setDims(null); setFileSize(null); setAiTools([]); setAiPrompt(null); setAiUpscale(null); setProv(null); }
  }, [open]);
  // zmiana zdjęcia (PREV/NEXT) → porzuć wynik edycji poprzedniego oraz ślad AI. Wymiary bierzemy WPROST z metadanych
  // źródła (AssetMetadata width/height — synchronicznie, autorytatywnie); dopiero gdy ich brak → fallback na onLoad.
  useEffect(() => {
    setWorkingUri(null); setFillOffer(false); setFileSize(null); setAiTools([]); setAiPrompt(null); setAiUpscale(null);
    const mw = (source as any)?.mediaWidth, mh = (source as any)?.mediaHeight;
    if (typeof mw === 'number' && typeof mh === 'number' && mw > 0 && mh > 0) { setDims({ w: mw, h: mh }); assetDimsRef.current = true; }
    else { setDims(null); assetDimsRef.current = false; }
  }, [source]);
  // prowieniencja (IPTC/C2PA — LEKKA, sam nagłówek) + rozmiar pliku (getFileBytes — osobno, bez kopiowania).
  // Wymiary NIE stąd — biorą się z metadanych źródła (AssetMetadata) w efekcie [source] wyżej.
  // ⚠️ PERF: TYLKO gdy panel INFO jest OTWARTY (`open && infoOpen`) — inaczej getProvenance (256KB read + b64ToStr =
  // alokacja + blokada JS) leciałby przy KAŻDYM swipie w immersive → GC co kilka przesunięć = skoki FPS. Dane INFO
  // są potrzebne dopiero, gdy panel widać.
  useEffect(() => {
    setProv(null);
    if (!open || !infoOpen) return;
    let uri = ''; try { uri = RNImage.resolveAssetSource(source as any)?.uri ?? ''; } catch { /* ignore */ }
    if (!uri) return;
    let alive = true;
    getProvenance(uri).then((p) => { if (alive) setProv(p); }).catch(() => {});
    getFileBytes(uri).then((b) => { if (alive && b != null) setFileSize(formatBytes(b)); }).catch(() => {});
    return () => { alive = false; };
  }, [source, open, infoOpen]);
  // wyjście z widoku AI → zakończ pisanie; wejście w pod-widok → schowaj ofertę wypełnienia
  useEffect(() => { if (view !== 'ai') setTyping(false); if (view !== 'viewer') setFillOffer(false); }, [view]);
  // gdy zakładka główna nie jest AI EDIT → nie ma pod-paska, więc fokus wraca na pasek główny
  useEffect(() => { if (mainIdx !== 0 && menuTier === 'sub') setMenuTier('main'); }, [mainIdx, menuTier]);
  // schowanie systemowej klawiatury (Android adjustNothing nie woła onBlur) → wyjście z trybu pisania
  useEffect(() => {
    if (!typing) return;
    const sub = RNKeyboard.addListener('keyboardDidHide', () => { setTyping(false); inputRef.current?.blur(); });
    return () => sub.remove();
  }, [typing]);

  const toViewer = () => setView('viewer');
  // TOAST — pokaż krótki komunikat (auto-znika)
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  };

  // MENU EDIT (dwupoziomowy pasek). Otwarcie/zamknięcie + nawigacja joystickiem.
  const openMenu = () => { setMenuTier('main'); setMenuOpen(true); };
  const closeMenu = () => setMenuOpen(false);
  const enterCrop = () => { setCropDirty(false); setMenuOpen(false); setView('crop'); };
  // TEXT TO IMAGE: ląduj w trybie maski (można malować zaznaczenie); klawiaturę promptu otwiera klawisz KEYBOARD.
  const enterAi = () => { setMainIdx(0); setMenuOpen(false); setView('ai'); };
  const enterMagicErase = () => { setMainIdx(0); setMenuOpen(false); setView('magicErase'); };
  // pod-pasek funkcji AI: 0=MAGIC ERASE (stage), 1=TEXT TO IMAGE (prompt), 2=UPSCALE (jednoklik), 3=FILTERS (stub „SOON")
  const activateAiFunc = (i: number) => {
    if (i === 0) enterMagicErase();
    else if (i === AI_TEXT2IMG) enterAi();
    else if (i === AI_UPSCALE) runUpscale();
    else showToast(`${AI_FUNCS[i]} — SOON`);
  };
  const chooseAiFunc = (i: number) => { setAiIdx(i); setMenuTier('sub'); activateAiFunc(i); };
  // pasek główny: AI EDIT → zejdź na pod-pasek funkcji; CROP & ROTATE → od razu akcja
  const chooseMainTab = (i: number) => {
    setMainIdx(i); setMenuTier('main');
    if (i === 1) enterCrop();
    else setMenuTier('sub'); // AI EDIT → fokus na funkcjach
  };
  // joystick w menu: ‹/› = ruch w obrębie poziomu, ▲/▼ = zmiana poziomu, press = zatwierdź
  // nawigacja zapętlona (loop): z końca paska wracamy na początek i odwrotnie
  const menuNav = (d: number) => {
    if (menuTier === 'sub') setAiIdx((i) => (i + d + AI_FUNCS.length) % AI_FUNCS.length);
    else setMainIdx((i) => (i + d + MAIN_TABS.length) % MAIN_TABS.length);
  };
  // Pion: GÓRA wchodzi na poziom 2 (pod-pasek AI, tylko gdy AI EDIT), DÓŁ cofa na poziom 1.
  const menuTierUp = () => { if (mainIdx === 0) setMenuTier('sub'); };
  const menuTierDown = () => setMenuTier('main');
  const menuActivate = () => {
    if (menuTier === 'sub') { activateAiFunc(aiIdx); return; }
    if (mainIdx === 1) enterCrop();
    else setMenuTier('sub'); // AI EDIT
  };
  // APPLY (crop) — wypal kadr/rotację, podmień obraz roboczy i wróć do podglądu (badge → EDIT).
  // Zapis do biblioteki NIE tutaj — robi to SAVE w viewerze (spójnie z APPLY→SAVE w Magic Erase).
  // Jeśli kadr zostawił puste obszary (obrót) → zaproponuj wypełnienie AI w podglądzie.
  const applyCrop = async () => {
    const res = await cropRef.current?.apply();
    // wynik manipulatora leży w jego cache'u → przenieś do katalogu roboczego, żeby dożył do SAVE
    if (res?.uri) { setWorkingUri(await persistWorkFile(res.uri)); setFillOffer(res.needsFill); }
    setView('viewer');
  };

  // FILL — wypełnij puste obszary (po obrocie) przez AI (deAPI: z-image / qwen-edit-plus)
  const fillAI = async () => {
    if (!workingUri || processing) return;
    setProcLabel('GENERATIVE FILL…'); setProcessing(true); setAiError(null);
    try {
      const res = await fillImage({ uri: workingUri });
      // wynik (zdalny https / data:) sprowadzamy do lokalnego pliku — pod zapis i kolejne edycje
      if (res?.uri) { setWorkingUri(await ensureLocalFile(res.uri)); addAiTool('GEN FILL'); }
      setFillOffer(false);
    } catch (e) {
      // fill też działa w viewerze → błąd toastem (aiError renderuje się tylko w AiStage)
      showToast(e instanceof Error ? `ERROR: ${e.message}` : 'FILL FAILED');
    } finally {
      setProcessing(false);
    }
  };
  const skipFill = () => setFillOffer(false);

  // UPSCALE — jednoklik: powiększ/wyostrz aktualny obraz dedykowanym modelem (deAPI: RealESRGAN x4).
  const runUpscale = async () => {
    if (processing) return;
    const uri = resolveUri(displaySource); // aktualny obraz (workingUri jeśli edytowany, inaczej źródło)
    if (!uri) { showToast('NO IMAGE SOURCE'); return; }
    setMenuOpen(false); setView('viewer'); setAiError(null);
    setProcLabel('UPSCALING…'); setProcessing(true);
    try {
      const res = await upscaleImage({ uri });
      if (res?.uri) { setWorkingUri(await ensureLocalFile(res.uri)); addAiTool('UPSCALE'); setAiUpscale(4); }
    } catch (e) {
      // upscale działa w viewerze (nie w AiStage), więc błąd pokazujemy toastem — inaczej byłby niewidoczny
      showToast(e instanceof Error ? `ERROR: ${e.message}` : 'UPSCALE FAILED');
    } finally {
      setProcessing(false);
    }
  };

  // AI EDIT — sterowanie klawiaturą/promptem
  const resolveUri = (src?: ImageSourcePropType) => { try { return RNImage.resolveAssetSource(src as any)?.uri ?? ''; } catch { return ''; } };
  const openKeyboard = () => { setAiError(null); setTyping(true); setTimeout(() => inputRef.current?.focus(), 0); };
  const cancelTyping = () => { setTyping(false); inputRef.current?.blur(); };
  const sendPrompt = async () => {
    const p = draft.trim();
    if (!p || processing || boosting) return;
    setTyping(false); inputRef.current?.blur();
    const uri = resolveUri(displaySource);
    if (!uri) { setAiError('NO IMAGE SOURCE'); return; }
    setAiError(null);
    // PROMPT BOOSTER: najpierw ulepsz prompt (stub); jeśli booster padnie, jedź na oryginalnym promptcie
    let prompt = p;
    if (promptBooster) {
      setBoosting(true);
      try { const b = await boostPrompt({ prompt: p }); prompt = b.prompt || p; }
      catch { /* fallback: oryginalny prompt */ }
      finally { setBoosting(false); }
    }
    // maska (jeśli coś zamalowano) → INPAINTING: prompt zmienia tylko zaznaczenie, reszta zdjęcia zostaje
    const mask = aiMaskRef.current?.getMask() ?? null;
    setProcessing(true);
    try {
      const res = await editImage({ uri, prompt, mask });
      // wynik (zdalny https / data:) sprowadzamy do lokalnego pliku — pod zapis i kolejne edycje
      if (res?.uri) { setWorkingUri(await ensureLocalFile(res.uri)); addAiTool(mask ? 'INPAINT' : 'TEXT-TO-IMAGE'); setAiPrompt(p); setDraft(''); setView('viewer'); }
    } catch (e) {
      setAiError(e instanceof Error ? `ERROR: ${e.message}` : 'EDIT FAILED');
    } finally {
      setProcessing(false);
    }
  };

  // SAVE — zapis obrazu roboczego (edytowanego) do biblioteki; krótki feedback (toast)
  const saveWorking = async () => {
    if (!workingUri) return;
    const res = await saveImageToLibrary(workingUri, { ai: aiTools.length > 0 });
    showToast(res === 'ok' ? 'SAVED' : res === 'denied' ? 'NO SAVE PERMISSION' : 'SAVE FAILED');
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // back: (processing = blokada) → oferta fill → pisanie → menu → pod-widok → (false = zamknij podgląd)
  const goBack = (): boolean => {
    if (processing || boosting || magic.processing) return true;   // w trakcie boostu/edycji/wypełniania/erase AI back nic nie robi (blokada)
    if (fillOffer) { setFillOffer(false); return true; }
    if (typing) { setTyping(false); return true; }
    // BACK najpierw ZWIJA poziom 2 menu (pasek trybów / pokrętło pędzla), dopiero potem wychodzi z widoku.
    if (magicRef.current?.collapse()) return true;
    if (aiMaskRef.current?.collapse()) return true;
    if (menuTier === 'sub') { setMenuTier('main'); return true; } // zwiń poziom 2 menu EDIT
    if (infoOpen) { setInfoOpen(false); return true; }
    if (view !== 'viewer') { setView('viewer'); return true; }
    if (menuOpen) { setMenuOpen(false); return true; }
    return false;
  };

  // etykieta paska statusu + status AI (deAPI). Pulsuje w trakcie przetwarzania (edycja AI / wypełnianie).
  // Badge = VIEWER dopóki edycja NIE jest zatwierdzona (brak obrazu roboczego); dopiero commit (SAVE crop /
  // APPLY erase / SEND AI ustawiają workingUri) przełącza na EDIT. Samo otwarcie menu / kadrowanie = wciąż VIEWER.
  const label = workingUri ? 'EDIT' : 'VIEWER';
  const ai: AiStatusView | undefined = boosting
    ? { lines: ['PROMPT BOOSTER', 'BOOSTING…'], pulse: true }
    : magic.processing
      ? { lines: ['MAGIC ERASE', magic.removeBg ? 'REMOVING BG…' : 'ERASING…'], pulse: true }
      : processing
      ? { lines: ['AI IMAGE EDIT', view === 'ai' ? 'PROCESSING…' : procLabel], pulse: true }
      : view === 'ai'
        // gdy booster aktywny → pasek zapowiada PROMPT BOOSTER WITH DEAPI (dwie linie obok ikony AI)
        ? { lines: promptBooster ? ['PROMPT BOOSTER', 'WITH DEAPI'] : ['AI IMAGE EDIT', 'WITH DEAPI'], pulse: false }
        : undefined;

  // KLAWIATURA per pod-widok/stan (Figma 402:5598). VIEWER (menu zamknięte): EDIT · INFO · joy · MENU · BACK;
  // menu otwarte: CLOSE EDIT · INFO · joy(nawigacja) · MENU · BACK. Sloty metalowe (2/4) renderowane jak „screen".
  // Puste sloty = WIDOCZNE puste klawisze (szkło), nie dziury.
  const metalBlank: KeyboardConfig['metal'] = [{ type: 'label', upper: '' }, { type: 'label', upper: '' }];
  // slot metal[0] (poz. 2): INFO ⇄ HIDE INFO (panel parametrów). Gdy panel zamknięty, a jest wynik edycji → SAVE.
  const infoSlot: KeyboardConfig['metal'][number] = infoOpen
    ? { type: 'label', upper: 'HIDE\nINFO', variant: 'primary', active: true, onPress: () => setInfoOpen(false) }
    : workingUri
      ? { type: 'label', upper: 'SAVE', active: true, onPress: saveWorking }
      : { type: 'label', upper: 'INFO', active: true, onPress: () => setInfoOpen(true) };
  const magicNavJoy: KeyboardConfig['joystick'] = {
    highlighted: true, repeat: true,
    onLeft: () => magicRef.current?.navLeft(),
    onRight: () => magicRef.current?.navRight(),
    onUp: () => magicRef.current?.navUp(),
    onDown: () => magicRef.current?.navDown(),
    onPress: () => magicRef.current?.press(),
  };
  let keyboard: KeyboardConfig;
  if (view === 'magicErase') {
    // MAGIC ERASE (Figma _AI 424:6660). Malowanie maski palcem; dolny dwupoziomowy pasek steruje trybem.
    // Klawisze: APPLY · UNDO · joy(nawigacja paska) · RESET · BACK; po zastosowaniu → SAVE zamiast APPLY/UNDO.
    if (magic.processing) {
      keyboard = { screen: [{ label: '' }, { label: '' }], metal: metalBlank, joystick: { highlighted: false } };
    } else if (magic.applied) {
      keyboard = {
        screen: [{ label: 'SAVE', variant: 'primary', onPress: saveWorking }, { label: 'BACK', onPress: toViewer }],
        metal: [{ type: 'label', upper: '' }, { type: 'label', upper: 'RESET', variant: 'risk', active: true, onPress: () => magicRef.current?.reset() }],
        joystick: magicNavJoy,
      };
    } else if (magic.removeBg) {
      // REMOVE BACKGROUND — jednoklik (bez malowania i UNDO/RESET)
      keyboard = {
        screen: [{ label: 'APPLY', variant: 'primary', onPress: () => magicRef.current?.apply() }, { label: 'BACK', onPress: toViewer }],
        metal: metalBlank,
        joystick: magicNavJoy,
      };
    } else {
      // APPLY pojawia się DOPIERO, gdy jest co wysłać (jak w CROP: klawisz wchodzi po pierwszej zmianie).
      // Wcześniej świecił zawsze, a naciśnięcie bez zaznaczenia nie robiło nic — bez śladu, że trzeba
      // najpierw zamalować obszar. Liczą się tylko pociągnięcia ADD; sama „gumka" nic nie zaznacza.
      keyboard = {
        screen: [
          magic.hasSelection ? { label: 'APPLY', variant: 'primary', onPress: () => magicRef.current?.apply() } : { label: '' },
          { label: 'BACK', onPress: toViewer },
        ],
        metal: [
          { type: 'label', upper: 'UNDO', active: true, onPress: () => magicRef.current?.undo() },
          { type: 'label', upper: 'RESET', variant: 'risk', active: true, onPress: () => magicRef.current?.reset() },
        ],
        joystick: magicNavJoy,
      };
    }
  } else if (view === 'crop') {
    // CROP & ROTATE (Figma 402:5598). Sterowanie kadrem TYLKO gestami + joystickiem:
    // joystick góra/dół = panel (rotacja ⇄ proporcje), lewo/prawo = reguluj, pinch/pan na obrazie = kadr/obrót.
    // Klawisze: dopóki nic nie zmieniono → tylko BACK; po zmianie → APPLY (wypal do obrazu roboczego) · RESET · BACK.
    const cropJoy: KeyboardConfig['joystick'] = {
      highlighted: true,
      repeat: true, // przytrzymanie L/P powtarza regulację aktywnego panelu (np. ciągły obrót)
      onUp: () => cropRef.current?.focusRotation(),
      onDown: () => cropRef.current?.focusRatio(),
      onLeft: () => cropRef.current?.adjust(-1),
      onRight: () => cropRef.current?.adjust(1),
    };
    keyboard = cropDirty
      ? {
          screen: [{ label: 'APPLY', variant: 'primary', onPress: applyCrop }, { label: 'BACK', onPress: toViewer }],
          metal: [{ type: 'label', upper: '' }, { type: 'label', upper: 'RESET', variant: 'risk', active: true, onPress: () => cropRef.current?.reset() }],
          joystick: cropJoy,
        }
      : {
          screen: [{ label: '' }, { label: 'BACK', onPress: toViewer }],
          metal: metalBlank,
          joystick: cropJoy,
        };
  } else if (view === 'ai') {
    // TEXT TO IMAGE: idle → KEYBOARD · UNDO · joy(nawigacja pędzla) · RESET · BACK (malujesz maskę + pędzel);
    // typing → CANCEL · SEND; boost/processing → klawisze wygaszone. SEND stosuje prompt (do maski = inpaint).
    if (processing || boosting) {
      keyboard = { screen: [{ label: '' }, { label: '' }], metal: metalBlank, joystick: { highlighted: false } };
    } else if (typing) {
      keyboard = {
        screen: [{ label: 'CANCEL', onPress: cancelTyping }, { label: 'SEND', variant: 'primary', onPress: sendPrompt }],
        metal: metalBlank,
        joystick: { highlighted: true, onPress: sendPrompt },
      };
    } else {
      keyboard = {
        screen: [{ label: 'KEY-\nBOARD', variant: 'primary', onPress: openKeyboard }, { label: 'BACK', onPress: toViewer }],
        metal: [
          { type: 'label', upper: 'UNDO', active: true, onPress: () => aiMaskRef.current?.undo() },
          { type: 'label', upper: 'RESET', variant: 'risk', active: true, onPress: () => aiMaskRef.current?.reset() },
        ],
        joystick: {
          highlighted: true, repeat: true,
          onLeft: () => aiMaskRef.current?.navLeft(),
          onRight: () => aiMaskRef.current?.navRight(),
          onUp: () => aiMaskRef.current?.navUp(),
          onDown: () => aiMaskRef.current?.navDown(),
          onPress: () => aiMaskRef.current?.press(),
        },
      };
    }
  } else if (menuOpen) {
    // MENU EDIT otwarte (Figma _AI): CLOSE EDIT (zamyka menu) · INFO/SAVE · joy(nawigacja) · MENU(zamknij) · BACK(wyjście).
    // CLOSE EDIT = zamknij menu edycji (wróć do podglądu), NIE wychodź z edytora. BACK = wyjście do galerii.
    // joystick: ‹/› = ruch w poziomie, ▲/▼ = przełącz poziom (funkcje AI ⇄ zakładki), press = zatwierdź.
    keyboard = {
      screen: [
        { label: 'CLOSE\nEDIT', variant: 'primary', onPress: closeMenu },
        { label: 'BACK', onPress: onExit },
      ],
      metal: [infoSlot, { type: 'label', upper: 'MENU', active: true, onPress: closeMenu }],
      joystick: {
        highlighted: true,
        onLeft: () => menuNav(-1),
        onRight: () => menuNav(1),
        onUp: menuTierUp,
        onDown: menuTierDown,
        onPress: menuActivate,
      },
    };
  } else {
    if (processing) {
      // trwa przetwarzanie AI (fill/upscale) — klawisze i joystick wygaszone (blokuje też nawigację prev/next)
      keyboard = { screen: [{ label: '' }, { label: '' }], metal: metalBlank, joystick: { highlighted: false } };
    } else if (fillOffer) {
      // po kadrze z obrotem: propozycja wypełnienia pustych obszarów AI
      keyboard = {
        screen: [
          { label: 'SKIP', onPress: skipFill },
          { label: 'FILL\nAI', variant: 'primary', onPress: fillAI },
        ],
        metal: metalBlank,
        joystick: { highlighted: true, onPress: fillAI },
      };
    } else if (isVideo) {
      // WIDEO: zamiast EDIT stoi PLAY/PAUSE, a press joysticka też przełącza odtwarzanie. Menu EDIT jest
      // niedostępne (kadr i AI działają na zdjęciach), IMMERSIVE również — pełny ekran dla filmu to
      // osobna funkcja, nie ten sam pager co dla obrazów.
      keyboard = {
        screen: [
          { label: videoPlaying ? 'PAUSE' : 'PLAY', variant: 'primary', onPress: () => videoRef.current?.toggle() },
          { label: 'BACK', onPress: onExit },
        ],
        metal: [infoSlot, { type: 'label', upper: 'MENU', active: !!onMenu, onPress: onMenu }],
        joystick: {
          highlighted: true,
          onLeft: onPrev,
          onRight: onNext,
          onPress: () => videoRef.current?.toggle(),
        },
      };
    } else {
      // VIEWER (menu zamknięte, Figma 402:5598): EDIT · INFO/SAVE · joy(prev/next, press=EDIT menu) · MENU · BACK.
      // EDIT otwiera dolne menu EDYCJI; MENU otwiera kontekstowe menu GALERII (domyślna funkcja); BACK wychodzi.
      keyboard = {
        screen: [
          { label: 'EDIT', onPress: openMenu },
          { label: 'BACK', onPress: onExit },
        ],
        metal: [infoSlot, { type: 'label', upper: 'MENU', active: true, onPress: onMenu ?? openMenu }],
        joystick: {
          highlighted: true,
          onLeft: onPrev,
          onRight: onNext,
          // press joysticka w podglądzie ORYGINAŁU → IMMERSIVE (pełny ekran); dla obrazu roboczego (edycja) → menu EDIT
          onPress: workingUri ? openMenu : (onRequestImmersive ?? openMenu),
        },
      };
    }
  }

  const content = (
    <>
      <ScreenTopBar mode="VIEWER" label={label} onCycleMode={view === 'viewer' && !menuOpen ? onCycleMode : undefined} ai={ai} labelActive />
      <View style={{ flex: 1, alignSelf: 'stretch', gap: 16 }}>
        {/* warstwa przygaszana; nakładka jest JEJ RODZEŃSTWEM, więc dialog nie gaśnie razem z treścią */}
        <View style={{ flex: 1, alignSelf: 'stretch', gap: 16, opacity: dimmed ? 0.25 : 1 }}>
        {/* content_area: obraz/pod-widok (zajmuje resztę wysokości), a pod nim — dolne menu EDIT */}
        <View style={{ flex: 1, alignSelf: 'stretch' }}>
          {view === 'viewer' && isVideo ? (
            <VideoStage ref={videoRef} source={source!} onPrev={onPrev} onNext={onNext} onPlayingChange={setVideoPlaying} />
          ) : view === 'viewer' ? (
            // KLUCZ tylko po wyniku edycji (workingUri) — NIE po zdjęciu. Klucz ze zdjęcia remountował cały
            // ZoomImage przy każdym PREV/NEXT, więc obraz ładował się od zera (pauza = „chrupnięcie" swipe'a).
            // Zerowanie zoomu przy zmianie zdjęcia robi teraz efekt wewnątrz ZoomImage.
            displaySource ? <ZoomImage key={workingUri ?? 'src'} source={displaySource} prevSource={workingUri ? undefined : prevSource} nextSource={workingUri ? undefined : nextSource} onPrev={processing ? undefined : onPrev} onNext={processing ? undefined : onNext} onSwipeUp={() => setInfoOpen(true)} onSwipeDown={() => setInfoOpen(false)} onDims={(w, h) => { if (!assetDimsRef.current) setDims({ w, h }); }} onImmersive={processing || workingUri ? undefined : onRequestImmersive} onExit={processing || workingUri ? undefined : onExit} /> : null
          ) : view === 'crop' ? (
            displaySource ? <CropStage ref={cropRef} source={displaySource} onDirty={setCropDirty} /> : null
          ) : view === 'magicErase' ? (
            displaySource ? (
              <MagicEraseStage
                ref={magicRef}
                source={displaySource}
                onResult={(uri) => {
                  setWorkingUri(uri);
                  if (uri) addAiTool(magic.removeBg ? 'REMOVE BG' : 'MAGIC ERASE');
                  else { setAiTools([]); setAiPrompt(null); } // RESET → wyczyść ślad AI
                }}
                onError={showToast}
                onState={setMagic}
              />
            ) : null
          ) : (
            displaySource ? (
              <AiStage
                ref={aiMaskRef}
                source={displaySource}
                draft={draft}
                typing={typing}
                processing={processing}
                error={aiError}
                inputRef={inputRef}
                onChangeText={setDraft}
                onSubmit={sendPrompt}
                onBlur={() => setTyping(false)}
                onOpenKeyboard={openKeyboard}
              />
            ) : null
          )}
        </View>

        {/* INFO — parametry obrazka + ślad AI (Figma _AI 426:7051). Nad menu, gdy oba otwarte. Swipe-up/INFO. */}
        {view === 'viewer' && infoOpen ? (
          <View style={{ alignSelf: 'stretch', gap: 8 }}>
            {/* NAZWA PLIKU — wyśrodkowana, tuż nad sekcją INFO (wcześniej siedziała w górnym pasku) */}
            <Text numberOfLines={1} style={{ fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: screen.olive.primary, textAlign: 'center', ...phosphorGlow }}>
              {truncName((source as any)?.filename)}
            </Text>
            <InfoPanel dims={dims} fileSize={fileSize} format={formatLabel((source as any)?.filename, !!(source as any)?.raw)} aiTools={aiTools} aiPrompt={aiPrompt} aiUpscale={aiUpscale} prov={prov} place={place} duration={(source as any)?.duration ?? null} />
          </View>
        ) : null}

        {/* MENU EDIT — dwupoziomowy pasek pod obrazem (Figma _AI), tylko w widoku VIEWER.
            Pod-pasek funkcji AI (MAGIC ERASE / TEXT TO IMAGE / FILTERS) tylko gdy aktywna zakładka AI EDIT. */}
        {menuOpen && view === 'viewer' ? (
          <View style={{ alignSelf: 'stretch', gap: 16 }}>
            {menuTier === 'sub' ? <MenuBar items={AI_FUNCS} index={aiIdx} focused onPick={chooseAiFunc} /> : null}
            <MenuBar items={MAIN_TABS} index={mainIdx} focused={menuTier === 'main'} onPick={chooseMainTab} />
          </View>
        ) : null}

        {/* propozycja wypełnienia AI (puste obszary po obrocie) — banner przy dolnej krawędzi */}
        {view === 'viewer' && fillOffer && !processing ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center', paddingHorizontal: 16 }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 2, backgroundColor: screen.olive.primary, ...(PILL as any) }}>
              <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: color.dark21, textAlign: 'center' }}>
                {'FILL EMPTY AREAS WITH GENERATIVE AI?'}
              </Text>
            </View>
          </View>
        ) : null}

        {/* nakładka przetwarzania (wypełnianie AI / magic erase) */}
        {(view === 'viewer' && processing) || (view === 'magicErase' && magic.processing) ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(26,26,26,0.55)' }}>
            <Text style={{ fontFamily: font.monoLabel.family, fontSize: 14, letterSpacing: 2, color: screen.olive.primary, ...phosphorGlow }}>
              {view === 'magicErase' ? (magic.removeBg ? 'REMOVING BACKGROUND…' : 'ERASING…') : procLabel}
            </Text>
          </View>
        ) : null}

        {/* toast (SAVE / SOON / INFO) — fosforowa pigułka przy górnej krawędzi (nie koliduje z dolnym menu) */}
        {toast ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 8, alignItems: 'center' }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 2, backgroundColor: screen.olive.primary, ...(PILL as any) }}>
              <Text style={{ fontFamily: font.bodyLgBold.family, fontSize: font.bodyLgBold.size, color: color.dark21 }}>
                {toast}
              </Text>
            </View>
          </View>
        ) : null}
        </View>
        {overlay}
      </View>
    </>
  );

  const info: ImageInfo = { open: infoOpen, setOpen: setInfoOpen, dims, fileSize, format: formatLabel((source as any)?.filename, !!(source as any)?.raw), filename: (source as any)?.filename ?? null, aiTools, aiPrompt, aiUpscale, prov, place, duration: (source as any)?.duration ?? null };
  return { content, keyboard, goBack, typing, info };
}
