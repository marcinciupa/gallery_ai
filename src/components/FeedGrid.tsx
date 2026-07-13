/**
 * FeedGrid — „feed": płaska siatka WSZYSTKICH mediów (kwadratowe kafle). Zaznaczony kafel dostaje podwójną
 * ramkę (jak w siatce) + TRÓJKĄTNY uchwyt w prawym-dolnym rogu; tap w uchwyt cykluje rozmiar kafla:
 *   • 2 kolumny: 1× ↔ 2×      • 3 kolumny: 1× → 2× → 3× → 1×
 * Reszta układa się automatycznie (skyline-masonry). Wirtualizacja RĘCZNA: kafle są absolutnie pozycjonowane
 * w ScrollView o policzonej wysokości, a renderujemy tylko te w oknie widoku (+bufor) — mount ≈ ekran, nie N.
 * (Pakowanie/filtr to tania arytmetyka O(N); ciężką rzeczą jest mount Views, który okno ogranicza.)
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, ScrollView, ImageSourcePropType, LayoutChangeEvent, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Polygon } from 'react-native-svg';
import { color, screen } from '../theme/tokens';

export const FEED_GAP = 8;

/**
 * Skyline packer: kwadratowe kafle K×K na siatce `cols`. Dla każdego kafla wybieramy pozycję NAJWYŻEJ, przy
 * remisie NAJBARDZIEJ W LEWO (topmost-leftmost). heights[c] = następny wolny wiersz w kolumnie c. O(N·cols).
 */
export function packFeed(spans: number[], cols: number): { pos: { r: number; c: number; k: number }[]; rows: number } {
  const heights = new Array(cols).fill(0);
  const pos: { r: number; c: number; k: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const k = Math.min(Math.max(spans[i] || 1, 1), cols);
    let bestC = 0;
    let bestR = Infinity;
    for (let c = 0; c + k <= cols; c++) {
      let r = 0;
      for (let d = 0; d < k; d++) r = Math.max(r, heights[c + d]);
      if (r < bestR) { bestR = r; bestC = c; }
    }
    for (let d = 0; d < k; d++) heights[bestC + d] = bestR + k;
    pos.push({ r: bestR, c: bestC, k });
  }
  let rows = 0;
  for (let c = 0; c < cols; c++) if (heights[c] > rows) rows = heights[c];
  return { pos, rows };
}

const FeedTile = memo(function FeedTile({
  source, x, y, size, selected, images, onOpen, onCycle,
}: {
  source?: ImageSourcePropType; x: number; y: number; size: number; selected?: boolean; images?: boolean;
  onOpen?: () => void; onCycle?: () => void;
}) {
  const overlay = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2 };
  return (
    <Pressable onPress={onOpen} style={{ position: 'absolute', left: x, top: y, width: size, height: size }}>
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
          {/* uchwyt zmiany rozmiaru — trójkąt w prawym-dolnym rogu */}
          <Pressable onPress={onCycle} hitSlop={8} style={{ position: 'absolute', right: 3, bottom: 3, padding: 3 }}>
            <Svg width={12} height={12}>
              <Polygon points="0,12 12,0 12,12" fill={screen.olive.primary} />
            </Svg>
          </Pressable>
        </>
      ) : null}
    </Pressable>
  );
});

export const FeedGrid = memo(function FeedGrid({
  data, cols, width, spans, selected, images = true, onCycleSpan, onOpen,
}: {
  data: ImageSourcePropType[];
  cols: number;
  width: number;
  spans: Record<number, number>;
  selected: number;
  images?: boolean;
  onCycleSpan: (i: number) => void;
  onOpen: (i: number) => void;
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

  const scrollRef = useRef<ScrollView>(null);
  const [viewH, setViewH] = useState(0);
  const [win, setWin] = useState({ top: 0, bottom: 0 });
  const lastY = useRef(0);

  const setWindow = (y: number, vh: number) => {
    const buf = step * 2;
    setWin({ top: y - buf, bottom: y + vh + buf });
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (Math.abs(y - lastY.current) >= step) { lastY.current = y; setWindow(y, viewH); } // przelicz okno raz na wiersz
  };
  const onLayout = (e: LayoutChangeEvent) => { const h = e.nativeEvent.layout.height; setViewH(h); setWindow(lastY.current, h); };

  // auto-scroll: widok podąża za zaznaczeniem (joystick/PREV/NEXT) — wyśrodkuj wiersz zaznaczonego kafla
  useEffect(() => {
    const p = pos[selected];
    if (!p || viewH <= 0) return;
    const sizeSel = p.k * cell + (p.k - 1) * gap;
    const target = Math.max(0, p.r * step + inset + sizeSel / 2 - viewH / 2);
    try { scrollRef.current?.scrollTo({ y: target, animated: true }); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, cols]);

  return (
    <ScrollView
      ref={scrollRef}
      scrollEventThrottle={32}
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
              selected={i === selected}
              images={images}
              onOpen={() => onOpen(i)}
              onCycle={() => onCycleSpan(i)}
            />
          );
        })}
      </View>
    </ScrollView>
  );
});
