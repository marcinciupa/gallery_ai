/**
 * FeedGrid — „feed": płaska siatka WSZYSTKICH mediów (kwadratowe kafle). Zaznaczony kafel dostaje podwójną
 * ramkę (jak w siatce) + TRÓJKĄTNY uchwyt w prawym-dolnym rogu; tap w uchwyt cykluje rozmiar kafla:
 *   • 2 kolumny: 1× ↔ 2×      • 3 kolumny: 1× → 2× → 3× → 1×
 * Reszta układa się automatycznie (grid-masonry z backfillem dziur). Wirtualizacja RĘCZNA: kafle są absolutnie pozycjonowane
 * w ScrollView o policzonej wysokości, a renderujemy tylko te w oknie widoku (+bufor) — mount ≈ ekran, nie N.
 * (Pakowanie/filtr to tania arytmetyka O(N); ciężką rzeczą jest mount Views, który okno ogranicza.)
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ImageSourcePropType, LayoutChangeEvent, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Polygon } from 'react-native-svg';
import { color, font, screen } from '../theme/tokens';

export const FEED_GAP = 8;

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

const FeedTile = memo(function FeedTile({
  source, x, y, size, selected, images, onOpen, onCycle, onLongPress, selectMode, check,
}: {
  source?: ImageSourcePropType; x: number; y: number; size: number; selected?: boolean; images?: boolean;
  onOpen?: () => void; onCycle?: () => void; onLongPress?: () => void; selectMode?: boolean; check?: boolean | null;
}) {
  const overlay = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2 };
  return (
    <Pressable onPress={onOpen} onLongPress={onLongPress} delayLongPress={350} style={{ position: 'absolute', left: x, top: y, width: size, height: size }}>
      <View style={{ flex: 1, borderRadius: 2, overflow: 'hidden' }}>
        {images && source ? (
          <ExpoImage source={source} contentFit="cover" cachePolicy="memory-disk" style={{ width: '100%', height: '100%' }} />
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
            <Pressable onPress={onCycle} hitSlop={8} style={{ position: 'absolute', right: 3, bottom: 3, padding: 3 }}>
              <Svg width={12} height={12}>
                <Polygon points="0,12 12,0 12,12" fill={screen.olive.primary} />
              </Svg>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {/* checkbox trybu zaznaczania — lewy-górny róg */}
      {check != null ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, borderRadius: 3, borderWidth: 2, borderColor: screen.olive.primary, backgroundColor: check ? screen.olive.primary : 'rgba(26,26,26,0.45)', alignItems: 'center', justifyContent: 'center' }}>
          {check ? <Text style={{ fontFamily: font.monoBody.family, fontSize: 12, lineHeight: 13, color: color.dark21 }}>{'✓'}</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
});

export const FeedGrid = memo(function FeedGrid({
  data, cols, width, spans, selected, images = true, onCycleSpan, onOpen, onSelectAt, onScrollActive, selectMode, checkedAt, onLongPressAt,
}: {
  data: ImageSourcePropType[];
  cols: number;
  width: number;
  spans: Record<number, number>;
  selected: number;
  images?: boolean;
  onCycleSpan: (i: number) => void;
  onOpen: (i: number) => void;
  onSelectAt?: (i: number) => void; // przy swipie kursor podąża za scrollem (kafel w środku pionowym; 3 kol.→środek, 2 kol.→lewa)
  onScrollActive?: (active: boolean) => void; // trwa swipe → chowaj kursor (true na start, false po zatrzymaniu)
  selectMode?: boolean;                       // tryb zaznaczania → checkbox zamiast uchwytu, tap = toggle
  checkedAt?: (i: number) => boolean;         // czy kafel i jest zaznaczony
  onLongPressAt?: (i: number) => void;        // long-press → wejście w tryb zaznaczania (z tym kaflem)
}) {
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
  const lastY = useRef(0);
  const userScrolling = useRef(false);          // trwa swipe/momentum → auto-scroll wyłączony (nie walczy ze swipem)
  const scrollStopT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSel = useRef<number | null>(null); // kafel pod środkiem — ustawiany w `selected` DOPIERO po zatrzymaniu

  const setWindow = (y: number, vh: number) => {
    const buf = step * 2;
    setWin({ top: y - buf, bottom: y + vh + buf });
  };
  // userScrolling ustawiamy TYLKO z realnego drag (onScrollBeginDrag) — programowy scrollTo (auto-scroll joysticka)
  // też odpala onScroll, ale NIE onScrollBeginDrag, więc nie blokuje wtedy auto-scrollu ani nie „podąża".
  const onScrollBeginDrag = () => { userScrolling.current = true; onScrollActive?.(true); if (scrollStopT.current) clearTimeout(scrollStopT.current); };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (Math.abs(y - lastY.current) >= step) { lastY.current = y; setWindow(y, viewH); } // przelicz okno raz na wiersz
    if (!userScrolling.current) return; // scroll programowy → tylko okno wirtualizacji; bez podążania i blokady
    if (scrollStopT.current) clearTimeout(scrollStopT.current); // reset flagi po chwili ciszy (koniec swipe+momentum)
    // PERF: kursor jest schowany podczas swipe (onScrollActive), więc NIE wołamy setSelected na każde zdarzenie
    // scrolla (to re-renderowało cały GalleryScreen ~30×/s = okresowe spadki fps). Zapamiętujemy kafel pod środkiem
    // i ustawiamy `selected` RAZ, po zatrzymaniu — dokładnie gdy kursor wraca.
    if (onSelectAt && viewH > 0) {
      const r = Math.max(0, Math.floor((y + viewH / 2 - inset) / step));
      const idx = cellGrid[r]?.[cols === 3 ? 1 : 0];
      if (idx != null) pendingSel.current = idx;
    }
    scrollStopT.current = setTimeout(() => {
      userScrolling.current = false;
      onScrollActive?.(false);
      if (pendingSel.current != null && pendingSel.current !== selected) onSelectAt?.(pendingSel.current);
      pendingSel.current = null;
    }, 160);
  };
  const onLayout = (e: LayoutChangeEvent) => { const h = e.nativeEvent.layout.height; setViewH(h); setWindow(lastY.current, h); };

  // auto-scroll: widok podąża za zaznaczeniem (joystick/PREV/NEXT) — wyśrodkuj wiersz zaznaczonego kafla.
  // `viewH` w zależnościach: po (re)montażu feeda (np. powrót z podglądu BACK) layout mierzy się PO pierwszym
  // renderze — bez tego efekt odpalał się przy viewH=0 (skip) i nigdy nie przywracał pozycji → skok na górę listy.
  const didScroll = useRef(false);
  useEffect(() => {
    const p = pos[selected];
    if (!p || viewH <= 0) return;
    if (userScrolling.current) return; // kursor podąża za swipem (onScroll) → nie centruj, żeby nie walczyć ze swipem
    const sizeSel = p.k * cell + (p.k - 1) * gap;
    const target = Math.max(0, p.r * step + inset + sizeSel / 2 - viewH / 2);
    const animated = didScroll.current; // pierwsze dojście (po layout) = przywrócenie bez animacji; kolejne (joystick) = z animacją
    didScroll.current = true;
    lastY.current = target; setWindow(target, viewH); // okno wirtualizacji od razu wokół celu (nie od góry)
    try { scrollRef.current?.scrollTo({ y: target, animated }); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, cols, viewH]);
  useEffect(() => () => { if (scrollStopT.current) clearTimeout(scrollStopT.current); }, []);

  return (
    <ScrollView
      ref={scrollRef}
      scrollEventThrottle={32}
      onScrollBeginDrag={onScrollBeginDrag}
      onScroll={onScroll}
      onLayout={onLayout}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, alignSelf: 'stretch' }}
    >
      <View style={{ height: totalH }}>
        {pos.map((p, i) => {
          const y = p.r * step + inset;
          const size = p.k * cell + (p.k - 1) * gap;
          if (y + size < win.top || y > win.bottom) return null; // poza oknem → nie montuj
          return (
            <FeedTile
              key={i}
              source={data[i]}
              x={p.c * step + inset}
              y={y}
              size={size}
              selected={i === selected || (!!selectMode && !!checkedAt?.(i))}
              images={images}
              onOpen={() => onOpen(i)}
              onCycle={() => onCycleSpan(i)}
              onLongPress={onLongPressAt ? () => onLongPressAt(i) : undefined}
              selectMode={selectMode}
              check={selectMode ? !!checkedAt?.(i) : undefined}
            />
          );
        })}
      </View>
    </ScrollView>
  );
});
