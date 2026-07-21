/**
 * FeedGrid — „feed": płaska siatka WSZYSTKICH mediów (kwadratowe kafle). Zaznaczony kafel dostaje podwójną
 * ramkę (jak w siatce) + TRÓJKĄTNY uchwyt w prawym-dolnym rogu; tap w uchwyt cykluje rozmiar kafla:
 *   • 2 kolumny: 1× ↔ 2×      • 3 kolumny: 1× → 2× → 3× → 1×
 * Reszta układa się automatycznie (grid-masonry z backfillem dziur). Wirtualizacja RĘCZNA: kafle są absolutnie pozycjonowane
 * w ScrollView o policzonej wysokości, a renderujemy tylko te w oknie widoku (+bufor) — mount ≈ ekran, nie N.
 * (Pakowanie/filtr to tania arytmetyka O(N); ciężką rzeczą jest mount Views, który okno ogranicza.)
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ImageSourcePropType, LayoutChangeEvent, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Polygon } from 'react-native-svg';
import { color, font, screen } from '../theme/tokens';
import { scrollFlag } from './PerfHud';

export const FEED_GAP = 8;

/** Uchwyt imperatywny: joystick przewija feed o STAŁY krok (patrz `nudge`). */
export type FeedGridHandle = {
  /** Joystick wychylony w pionie → zacznij ruch (najpierw jeden wiersz, potem płynny przesuw). */
  navStart: (dir: -1 | 1) => void;
  /** Joystick puszczony → zatrzymaj i wybierz kafel spod kotwicy. */
  navEnd: () => void;
};

/**
 * Grid-occupancy packer: kwadratowe kafle K×K na siatce `cols`. Dla każdego kafla szukamy PIERWSZEGO wolnego
 * bloku K×K, skanując topmost-leftmost po REALNEJ zajętości komórek (nie po skyline). Dzięki temu kolejne kafle
 * BACKFILLUJĄ dziury pod szerokimi kaflami — powiększenie jednego kafla nie zostawia trwałych wolnych slotów.
 * `searchStart` = pierwszy wiersz z jakąkolwiek wolną komórką (w pełni wypełnionych wierszy nie skanujemy) →
 * w praktyce O(N·cols): kursor przesuwa się do przodu, a „otwarte" pozostaje tylko wąskie pasmo przy froncie.
 */
export function packFeed(spans: number[], cols: number): { pos: { r: number; c: number; k: number }[]; rows: number } {
  const grid: boolean[][] = [];                                    // grid[r][c] = komórka zajęta
  const row = (r: number): boolean[] => {                          // leniwe rozszerzanie siatki w dół
    while (grid.length <= r) grid.push(new Array(cols).fill(false));
    return grid[r];
  };
  const fits = (r: number, c: number, k: number): boolean => {
    for (let dr = 0; dr < k; dr++) { const g = row(r + dr); for (let dc = 0; dc < k; dc++) if (g[c + dc]) return false; }
    return true;
  };
  const pos: { r: number; c: number; k: number }[] = new Array(spans.length);
  let searchStart = 0;
  for (let i = 0; i < spans.length; i++) {
    const k = Math.min(Math.max(spans[i] || 1, 1), cols);
    let pr = -1, pc = 0;
    for (let r = searchStart; pr < 0; r++) {                       // topmost-leftmost first-fit (pusty wiersz zawsze mieści k≤cols)
      for (let c = 0; c + k <= cols; c++) { if (fits(r, c, k)) { pr = r; pc = c; break; } }
    }
    for (let dr = 0; dr < k; dr++) { const g = row(pr + dr); for (let dc = 0; dc < k; dc++) g[pc + dc] = true; }
    pos[i] = { r: pr, c: pc, k };
    while (searchStart < grid.length && grid[searchStart].every(Boolean)) searchStart++; // pomiń wypełnione wiersze
  }
  let rows = 0;
  for (let r = grid.length - 1; r >= 0; r--) { if (grid[r].some(Boolean)) { rows = r + 1; break; } }
  return { pos, rows };
}

// PERF: przyjmuje `index` + callbacki index-owe (STABILNE między renderami FeedGrid), żeby `memo` trzymał podczas
// scrolla. Wcześniej domknięcia `() => onOpen(i)` były nowe co render → memo się psuł → przerysowanie WSZYSTKICH
// widocznych kafli na każdy krok scrolla (drogie przy dużych ExpoImage 2×/3× = lokalny spadek fps).
const FeedTile = memo(function FeedTile({
  index, source, x, y, size, span, lowQ, selected, images, onOpen, onCycle, onLongPress, selectMode, check,
}: {
  index: number; source?: ImageSourcePropType; x: number; y: number; size: number; span: number; lowQ?: boolean;
  selected?: boolean; images?: boolean;
  onOpen?: (i: number) => void; onCycle?: (i: number) => void; onLongPress?: (i: number) => void; selectMode?: boolean; check?: boolean | null;
}) {
  const overlay = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2 };
  return (
    <Pressable onPress={() => onOpen?.(index)} onLongPress={onLongPress ? () => onLongPress(index) : undefined} delayLongPress={350} style={{ position: 'absolute', left: x, top: y, width: size, height: size }}>
      <View style={{ flex: 1, borderRadius: 2, overflow: 'hidden' }}>
        {images && source ? (
          // LQIP dla POWIĘKSZONYCH kafli. `expo-image` dobiera rozmiar dekodowania do rozmiaru UKŁADU
          // (allowDownscaling domyślnie on), więc kafel 3× dekoduje ~9× więcej pikseli niż 1× — jeden taki
          // wjeżdżający w kadr blokował klatkę (zmierzone: dip do 24 fps, po naprawie ~76).
          //
          // DWIE WARSTWY, nie przełączanie stylu jednej: warstwa 1× jest zamontowana ZAWSZE i nigdy nie
          // zmienia rozmiaru układu, więc nigdy się nie przedekodowuje. Pełna rozdzielczość dokłada się
          // NAD nią dopiero po zatrzymaniu. Wariant z jednym <ExpoImage> i podmianą stylu wymuszał DWA
          // dodatkowe dekodowania na każdy gest (na 1× przy starcie, na pełny przy stopie).
          span > 1 ? (
            <>
              <ExpoImage
                source={source}
                contentFit="cover"
                cachePolicy="memory-disk"
                style={{ width: size / span, height: size / span, transform: [{ scale: span }], transformOrigin: 'top left' } as any}
              />
              {!lowQ ? (
                <ExpoImage
                  source={source}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={120} // łagodne wyostrzenie zamiast skoku
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                />
              ) : null}
            </>
          ) : (
            <ExpoImage source={source} contentFit="cover" cachePolicy="memory-disk" style={{ width: '100%', height: '100%' }} />
          )
        ) : (
          <View style={{ flex: 1, backgroundColor: '#3A3A3A' }} />
        )}
      </View>
      {selected ? (
        <>
          {/* podwójna ramka: czarna 3px pod, fosforowa 2px na wierzchu (jak PhosphorCover) */}
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 3, borderColor: color.dark1A }} />
          <View pointerEvents="none" style={{ ...overlay, borderWidth: 2, borderColor: screen.olive.primary }} />
          {/* uchwyt zmiany rozmiaru — trójkąt w prawym-dolnym rogu (ukryty w trybie zaznaczania) */}
          {!selectMode ? (
            <Pressable onPress={() => onCycle?.(index)} hitSlop={8} style={{ position: 'absolute', right: 3, bottom: 3, padding: 3 }}>
              <Svg width={12} height={12}>
                <Polygon points="0,12 12,0 12,12" fill={screen.olive.primary} />
              </Svg>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {/* checkbox trybu zaznaczania — lewy-górny róg */}
      {check != null ? (
        // Checkbox bez ptaszka (Figma 450:1861): niezaznaczony = fosforowy, ZAZNACZONY = ciemny.
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, borderRadius: 3, borderWidth: 2, borderColor: screen.olive.primary, backgroundColor: check ? color.dark21 : screen.olive.primary }}
        />
      ) : null}
    </Pressable>
  );
});

type FeedGridProps = {
  data: ImageSourcePropType[];
  cols: number;
  width: number;
  spans: Record<number, number>;
  selected: number;              // REALNY kursor (cel auto-scrolla) — NIE chowany, inaczej scroll traci cel
  hideCursor?: boolean;          // chowaj tylko RAMKĘ (swipe/hold) — scroll dalej podąża za `selected`
  images?: boolean;
  onCycleSpan: (i: number) => void;
  onOpen: (i: number) => void;
  onSelectAt?: (i: number) => void; // przy swipie kursor podąża za scrollem (kafel w środku pionowym; 3 kol.→środek, 2 kol.→lewa)
  onScrollActive?: (active: boolean) => void; // trwa swipe → chowaj kursor (true na start, false po zatrzymaniu)
  selectMode?: boolean;                       // tryb zaznaczania → checkbox zamiast uchwytu, tap = toggle
  checkedAt?: (i: number) => boolean;         // czy kafel i jest zaznaczony
  onLongPressAt?: (i: number) => void;        // long-press → wejście w tryb zaznaczania (z tym kaflem)
};

export const FeedGrid = memo(forwardRef<FeedGridHandle, FeedGridProps>(function FeedGrid({
  data, cols, width, spans, selected, hideCursor, images = true, onCycleSpan, onOpen, onSelectAt, onScrollActive, selectMode, checkedAt, onLongPressAt,
}: FeedGridProps, ref) {
  // Geometria 1:1 z gallery view: kolumna = width/cols (pitch), kafel 1× = kolumna − gap, margines zewn. = gap/2
  // (odpowiednik `padding: gap/2` na kaflach FlatListy). Dzięki temu feed ma tę samą szerokość i marginesy.
  const gap = FEED_GAP;
  const col = width / cols;   // szerokość kolumny (= itemWidth w gallery)
  const cell = col - gap;     // rozmiar kafla 1× (= obraz w gallery: itemWidth − gap)
  const step = col;           // krok siatki = szerokość kolumny
  const inset = gap / 2;      // margines zewnętrzny (jak gap/2 na kaflach gallery)

  const spanArr = useMemo(() => data.map((_, i) => Math.min(spans[i] || 1, cols)), [data.length, spans, cols]);
  const { pos, rows } = useMemo(() => packFeed(spanArr, cols), [spanArr, cols]);
  const totalH = rows > 0 ? rows * step : 0; // + margines gap/2 u góry i dołu (symetrycznie z gallery)

  // mapa komórka→index (do wyznaczenia kafla pod środkiem ekranu przy swipie)
  const cellGrid = useMemo(() => {
    const g: number[][] = [];
    pos.forEach((p, i) => { for (let dr = 0; dr < p.k; dr++) { const row = g[p.r + dr] || (g[p.r + dr] = []); for (let dc = 0; dc < p.k; dc++) row[p.c + dc] = i; } });
    return g;
  }, [pos]);

  const scrollRef = useRef<ScrollView>(null);
  const [viewH, setViewH] = useState(0);
  const [win, setWin] = useState({ top: 0, bottom: 0 });
  // Reaktywny stan przewijania (obok refa `userScrolling`) — steruje LQIP powiększonych kafli.
  // Zmienia się DWA razy na gest (start/stop), nie per klatka, więc nie wraca problem re-renderów.
  const [scrolling, setScrolling] = useState(false);

  // Lista indeksów WIDOCZNYCH kafli. Zwykłe liniowe przemiatanie `pos` z odsiewem — ZMIERZONE jako
  // szybsze od wariantu „sprytnego", który liczył okno z `cellGrid` (wiersz → indeksy) i na papierze miał
  // lepszą złożoność: 51 vs 41 fps min, A/B przełącznikiem w JEDNEJ sesji (2026-07-21).
  // Pętla po płaskiej tablicy z prostą arytmetyką jest dla silnika JS znacznie wdzięczniejsza niż
  // tablica 2D + Set + sort. NIE „optymalizować" tego z powrotem bez pomiaru.
  // (Względem pierwotnego `pos.map(...)` z `return null` oszczędzamy alokację N-elementowej tablicy.)
  const visible = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      const y = p.r * step + inset;
      const size = p.k * cell + (p.k - 1) * gap;
      if (y + size < win.top || y > win.bottom) continue;
      out.push(i);
    }
    return out;
  }, [win, pos, step, inset, cell, gap]);
  const lastY = useRef(0);
  // `lastY` jest CELOWO throttlowane (aktualizowane co wiersz — steruje oknem wirtualizacji i kierunkiem),
  // więc bywa nieaktualne nawet o cały wiersz. `curY` to pozycja RZECZYWISTA, aktualizowana na każde
  // zdarzenie scrolla — od niej liczymy kotwicę joysticka, inaczej zaznaczenie po zatrzymaniu wypada obok.
  const curY = useRef(0);
  const userScrolling = useRef(false);          // trwa realny swipe/momentum (NIE programowy) → settle na jego końcu
  const settleT = useRef<ReturnType<typeof setTimeout> | null>(null); // fallback settle, gdy po drag NIE ma momentum
  const skipAutoOnce = useRef(false);           // po swipe NIE re-centruj (kursor już na kaflu pod środkiem; inaczej „skacze")

  // PERF: stabilne callbacki (index-owe) trzymane w refie → FeedTile memo nie psuje się co render FeedGrid.
  const cbRef = useRef({ onOpen, onCycleSpan, onLongPressAt });
  cbRef.current = { onOpen, onCycleSpan, onLongPressAt };
  const openTile = useCallback((i: number) => cbRef.current.onOpen(i), []);
  const cycleTile = useCallback((i: number) => cbRef.current.onCycleSpan(i), []);
  const longTile = useCallback((i: number) => cbRef.current.onLongPressAt?.(i), []);

  const selRef = useRef(selected); selRef.current = selected;
  // Bufor wirtualizacji NIESYMETRYCZNY, zależny od kierunku przewijania. Kafel zaczyna dekodować obraz
  // w momencie ZAMONTOWANIA, więc bufor = wyprzedzenie, jakie dajemy dekodowaniu. Symetryczne 2 wiersze
  // marnowały połowę zapasu za plecami użytkownika; teraz 4 wiersze W PRZÓD (tam, gdzie kafle zaraz
  // wjadą w kadr) i 1 wstecz. Łącznie montujemy tylko o wiersz więcej niż wcześniej.
  const scrollDir = useRef(1); // 1 = w dół, -1 = w górę
  const setWindow = (y: number, vh: number) => {
    const ahead = step * 4;
    const behind = step * 1;
    const down = scrollDir.current >= 0;
    setWin({ top: y - (down ? behind : ahead), bottom: y + vh + (down ? ahead : behind) });
  };
  // KONIEC swipe (dokładny, ze zdarzeń RN): kafel pod ŚRODKIEM z FINALNEJ pozycji → ustaw `selected` RAZ i pokaż kursor.
  // Wcześniej: heurystyczny timer 160 ms + środek z ostatniego (nieprecyzyjnego) onScroll → kursor „nie mógł się zdecydować".
  const settle = (y: number) => {
    userScrolling.current = false;
    setScrolling(false);
    onScrollActive?.(false);
    if (onSelectAt && viewH > 0) {
      const r = Math.max(0, Math.floor((y + viewH / 2 - inset) / step));
      const idx = cellGrid[r]?.[cols === 3 ? 1 : 0];
      if (idx != null && idx !== selRef.current) { skipAutoOnce.current = true; onSelectAt(idx); }
    }
  };
  const clearSettle = () => { if (settleT.current) { clearTimeout(settleT.current); settleT.current = null; } };
  // userScrolling ustawiamy TYLKO z realnego drag (onScrollBeginDrag) — programowy scrollTo (auto-scroll joysticka)
  // odpala onScroll/momentum, ale NIE onScrollBeginDrag → userScrolling zostaje false, więc settle go NIE dotyczy.
  const onScrollBeginDrag = () => { userScrolling.current = true; scrollFlag.at = Date.now(); setScrolling(true); onScrollActive?.(true); clearSettle(); };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollFlag.at = Date.now(); // PerfHud: zatrzaskuj minimum tylko przy świeżym przewijaniu
    const y = e.nativeEvent.contentOffset.y;
    curY.current = y;
    if (Math.abs(y - lastY.current) >= step) {
      scrollDir.current = y >= lastY.current ? 1 : -1; // kierunek USTAL PRZED nadpisaniem lastY
      lastY.current = y;
      setWindow(y, viewH); // przelicz okno wirtualizacji raz na wiersz
    }
    // PERF: podczas swipe kursor jest SCHOWANY, więc NIE ruszamy `selected` per-frame (to re-renderowało cały ekran).
  };
  // brak momentum (powolne puszczenie) → settle po krótkiej chwili; jeśli momentum ruszy, anuluje to onMomentumScrollBegin
  const onScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!userScrolling.current) return;
    const y = e.nativeEvent.contentOffset.y;
    clearSettle();
    settleT.current = setTimeout(() => settle(y), 90);
  };
  const onMomentumScrollBegin = () => clearSettle();
  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!userScrolling.current) return; // programowy scroll (joystick) też odpala momentum — jego NIE settle'ujemy
    clearSettle();
    settle(e.nativeEvent.contentOffset.y);
  };
  const onLayout = (e: LayoutChangeEvent) => { const h = e.nativeEvent.layout.height; setViewH(h); setWindow(lastY.current, h); };

  // ── JOYSTICK: pojedyncze pchnięcie = kafel, przytrzymanie = płynny przesuw ───────────────────────
  // POJEDYNCZE pchnięcie w pionie przesuwa KURSOR na sąsiedni kafel — tym zajmuje się GalleryScreen
  // (`feedMoveV`), bo to on trzyma zaznaczenie i preferowaną kolumnę. FeedGrid dostaje tu tylko
  // zapowiedź: jeśli wychylenie potrwa dłużej niż CRUISE_DELAY_MS, przechodzimy w PŁYNNY przesuw.
  //
  // W trybie płynnym kursor jest schowany (jak przy swipie palcem), a na starcie zapamiętujemy
  // POZYCJĘ zaznaczonego kafla na ekranie (górna krawędź + kolumna). Po puszczeniu zaznaczamy kafel,
  // który znalazł się w tym samym miejscu — dzięki temu zaznaczenie nie „przeskakuje" na środek
  // ekranu. Przesuw jest liczony w px/s, więc jest równy niezależnie od wysokości mijanych kafli
  // (kafel 3× nie powoduje potrójnego przeskoku, jak przy nawigacji kafel-po-kaflu).
  const navAnchor = useRef<{ top: number; col: number } | null>(null);
  const navT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRaf = useRef(0);
  const navDir = useRef<-1 | 1>(1);
  const navPrevT = useRef(0);
  const CRUISE_ROWS_PER_SEC = 5;   // prędkość płynnego przesuwu (wierszy na sekundę) — główne pokrętło „feelu"
  const CRUISE_DELAY_MS = 240;     // po tylu ms trzymania krok zamienia się w płynny ruch

  const navSettle = () => {
    const a = navAnchor.current;
    navAnchor.current = null;
    onScrollActive?.(false);
    if (!a || !onSelectAt) return;
    const r = Math.max(0, Math.floor((curY.current + a.top - inset) / step));
    let idx = cellGrid[r]?.[a.col];
    for (let d = 1; idx == null && d < cols; d++) idx = cellGrid[r]?.[a.col - d] ?? cellGrid[r]?.[a.col + d];
    for (let dr = 1; idx == null && dr <= 2; dr++) idx = cellGrid[r + dr]?.[a.col] ?? cellGrid[r - dr]?.[a.col];
    if (idx == null) return;
    // Kotwica pilnuje tylko GÓRNEJ krawędzi, a kafel 2×/3× jest wyższy niż jeden wiersz — potrafił więc
    // wystawać poza dolną krawędź i kursor lądował „na granicy widoczności". Po wyborze dosuwamy widok
    // o NIEZBĘDNE MINIMUM, żeby cały kafel był w kadrze (bez centrowania — to by szarpało pozycją).
    const p = pos[idx];
    if (p) {
      const tileTop = p.r * step + inset;
      const tileH = p.k * cell + (p.k - 1) * gap;
      const top = curY.current;
      const bottom = top + viewH;
      if (tileTop < top) scrollToY(tileTop - inset, true);
      else if (tileTop + tileH > bottom) scrollToY(tileTop + tileH - viewH + inset, true);
    }
    if (idx !== selRef.current) { skipAutoOnce.current = true; onSelectAt(idx); }
  };

  const scrollToY = (y: number, animated: boolean) => {
    const maxY = Math.max(0, totalH - viewH);
    const target = Math.max(0, Math.min(maxY, y));
    lastY.current = target;
    curY.current = target;
    setWindow(target, viewH);
    scrollFlag.at = Date.now(); // PerfHud: to też jest przewijanie
    try { scrollRef.current?.scrollTo({ y: target, animated }); } catch {}
    return target;
  };

  // Płynny przesuw ze STAŁĄ prędkością. Krok po kroku (jeden wiersz na powtórzenie) czytało się jako
  // rytmiczne skakanie — użytkownik chciał ciągłego ruchu. Pojedynczy tap nadal daje DOKŁADNIE jeden
  // wiersz (precyzja wyboru), a dopiero przytrzymanie przechodzi w jazdę ciągłą.
  const navTick = (t: number) => {
    if (!navAnchor.current) return;
    const dt = navPrevT.current ? (t - navPrevT.current) / 1000 : 0;
    navPrevT.current = t;
    scrollToY(curY.current + navDir.current * CRUISE_ROWS_PER_SEC * step * dt, false);
    navRaf.current = requestAnimationFrame(navTick);
  };

  // Wejście w tryb płynny: dopiero TERAZ chowamy kursor i stawiamy kotwicę (nie przy pchnięciu —
  // pojedyncze pchnięcie ma zostać zwykłym przeskokiem kursora na sąsiedni kafel).
  const navCruise = () => {
    const p = pos[selRef.current];
    // Kotwica MUSI leżeć w widocznym pasmie. Zaznaczony kafel bywa poza ekranem (po swipie palcem,
    // po powrocie z podglądu) — bez przycięcia kotwica wiernie odtwarzała tę pozycję i zaznaczenie
    // po zatrzymaniu lądowało poza kadrem.
    const rawTop = p ? p.r * step + inset - curY.current : viewH / 2;
    navAnchor.current = {
      top: Math.max(0, Math.min(Math.max(0, viewH - step), rawTop)),
      col: p ? p.c : cols === 3 ? 1 : 0,
    };
    onScrollActive?.(true); // chowa ramkę kursora na czas płynnego ruchu
    navPrevT.current = 0;
    navRaf.current = requestAnimationFrame(navTick);
  };

  const navStart = (dir: -1 | 1) => {
    if (viewH <= 0) return;
    navDir.current = dir;
    if (navAnchor.current) return; // już jedziemy — zmieniamy tylko kierunek
    if (navT.current) clearTimeout(navT.current);
    navT.current = setTimeout(navCruise, CRUISE_DELAY_MS);
  };

  const navEnd = () => {
    if (navT.current) { clearTimeout(navT.current); navT.current = null; }
    if (navRaf.current) { cancelAnimationFrame(navRaf.current); navRaf.current = 0; }
    // Krótkie pchnięcie (nie doszło do trybu płynnego) → nic tu nie robimy: kursor przesunął już
    // GalleryScreen. Settle dotyczy WYŁĄCZNIE przesuwu płynnego, bo tylko on chował kursor.
    if (navAnchor.current) navT.current = setTimeout(navSettle, 120);
  };

  // Uchwyt przez ref-do-funkcji, żeby `useImperativeHandle` nie łapał nieaktualnego domknięcia.
  const navRef = useRef({ navStart, navEnd }); navRef.current = { navStart, navEnd };
  useImperativeHandle(ref, () => ({
    navStart: (d: -1 | 1) => navRef.current.navStart(d),
    navEnd: () => navRef.current.navEnd(),
  }), []);
  useEffect(() => () => {
    if (navT.current) clearTimeout(navT.current);
    if (navRaf.current) cancelAnimationFrame(navRaf.current);
  }, []);

  // auto-scroll: widok podąża za zaznaczeniem (joystick/PREV/NEXT), ale TYLKO GDY TRZEBA.
  // Dopóki zaznaczony kafel mieści się w całości w kadrze, widok STOI — przesuwa się dopiero, gdy kursor
  // dojedzie do krawędzi, i wtedy o niezbędne minimum. Wcześniej każdy krok kursora CENTROWAŁ zaznaczony
  // kafel, więc obszar jechał przy każdym ruchu, nawet w środku ekranu.
  // WYJĄTEK: pierwsze dojście po (re)montażu — wtedy centrujemy, bo to przywrócenie pozycji po powrocie
  // z podglądu; kafel na krawędzi byłby wtedy gorszy niż wyśrodkowany.
  // `viewH` w zależnościach: po (re)montażu feeda layout mierzy się PO pierwszym renderze — bez tego efekt
  // odpalał się przy viewH=0 (skip) i nigdy nie przywracał pozycji → skok na górę listy.
  const didScroll = useRef(false);
  useEffect(() => {
    const p = pos[selected];
    if (!p || viewH <= 0) return;
    if (userScrolling.current) return; // kursor podąża za swipem (onScroll) → nie ruszaj, żeby nie walczyć ze swipem
    if (skipAutoOnce.current) { skipAutoOnce.current = false; return; } // tuż po swipe: kursor już na miejscu
    const tileTop = p.r * step + inset;
    const tileH = p.k * cell + (p.k - 1) * gap;
    const first = !didScroll.current;
    didScroll.current = true;
    let target: number | null = null;
    if (first) {
      target = Math.max(0, tileTop + tileH / 2 - viewH / 2); // przywrócenie pozycji → wyśrodkuj
    } else if (tileTop < curY.current) {
      target = tileTop - inset;                              // wyjechał górą → dosuń w górę
    } else if (tileTop + tileH > curY.current + viewH) {
      target = tileTop + tileH - viewH + inset;              // wyjechał dołem → dosuń w dół
    }
    if (target == null) return; // mieści się w kadrze → NIE ruszaj widoku
    scrollToY(target, !first);  // przywrócenie bez animacji, ruch kursorem z animacją
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, cols, viewH]);
  useEffect(() => () => { if (settleT.current) clearTimeout(settleT.current); }, []);

  return (
    <ScrollView
      ref={scrollRef}
      scrollEventThrottle={32}
      onScrollBeginDrag={onScrollBeginDrag}
      onScroll={onScroll}
      onScrollEndDrag={onScrollEndDrag}
      onMomentumScrollBegin={onMomentumScrollBegin}
      onMomentumScrollEnd={onMomentumScrollEnd}
      onLayout={onLayout}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, alignSelf: 'stretch' }}
    >
      <View style={{ height: totalH }}>
        {visible.map((i) => {
          const p = pos[i];
          const y = p.r * step + inset;
          const size = p.k * cell + (p.k - 1) * gap;
          return (
            <FeedTile
              key={i}
              index={i}
              source={data[i]}
              x={p.c * step + inset}
              y={y}
              size={size}
              span={p.k}
              // LQIP tylko dla kafli k>1. Dla zwykłych prop jest STALE `false`, więc ich `memo` nie psuje
              // się przy starcie/stopie przewijania (patrz historia: psujące się domknięcia = jank).
              lowQ={p.k > 1 ? scrolling : false}
              selected={i === selected && !hideCursor} // ramka = KURSOR; zaznaczenie pokazuje checkbox
              images={images}
              onOpen={openTile}
              onCycle={cycleTile}
              onLongPress={onLongPressAt ? longTile : undefined}
              selectMode={selectMode}
              check={selectMode ? !!checkedAt?.(i) : undefined}
            />
          );
        })}
      </View>
    </ScrollView>
  );
}));
