/**
 * MomentsGrid — widok MOMENTS: zdjęcia pogrupowane po DACIE wykonania (i docelowo miejscu GPS),
 * z nagłówkiem per grupa i siatką 3-kolumnową. Wzorzec: galeria systemowa (data + miejscowość).
 *
 * Samodzielny komponent (jak FeedGrid): trzyma własny ScrollView, wirtualizację i „scroll-into-view"
 * kursora — dzięki temu nie trzeba wplatać MOMENTS w kilkadziesiąt rozgałęzień siatki w GalleryScreen.
 * Kursor (ramka) i zaznaczenie (checkbox) działają jak w reszcie apki.
 *
 * DATA: z `creationTime` (tanie, jest w metadanych). MIEJSCE: `placeOf(index)` — na razie zwykle
 * undefined, bo GPS wymaga getAssetInfoAsync (kopiuje plik per zdjęcie) + expo-location do reverse
 * geocode; nagłówek pokazuje miejsce dopiero, gdy `placeOf` je zwróci.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ImageSourcePropType, LayoutChangeEvent, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Polygon } from 'react-native-svg';
import { packFeed } from './FeedGrid';
import { color, font, screen } from '../theme/tokens';

export const MOMENTS_GAP = 8;
export const MOMENTS_COLS = 3;
const HEADER_H = 34; // wysokość paska nagłówka daty (label + miejsce w jednym wierszu)

export type MomentsGridHandle = { moveH: (dir: -1 | 1) => void; moveV: (dir: -1 | 1) => void };

// Dzień lokalny jako klucz grupy (YYYY-MM-DD wg strefy urządzenia).
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// `rows` trzyma już TYLKO nagłówki dat (kafle renderujemy osobno z `pos`, bo 2× łamie podział na wiersze).
type Row = { kind: 'header'; y: number; label: string; place?: string };

type MomentsGridProps = {
  data: ImageSourcePropType[];
  timeOf: (i: number) => number | null | undefined;
  placeOf?: (i: number) => string | undefined;
  width: number;
  selected: number;
  hideCursor?: boolean;
  images?: boolean;
  onOpen: (i: number) => void;
  onSelectAt?: (i: number) => void;
  onScrollActive?: (active: boolean) => void;
  spanOf?: (i: number) => number;      // 1 lub 2 — zdjęcie 2× w grupie
  onCycleSpan?: (i: number) => void;   // uchwyt: przełącz 2× (jedno na grupę)
  selectMode?: boolean;
  checkedAt?: (i: number) => boolean;
  onLongPressAt?: (i: number) => void;
};

const MomentTile = memo(function MomentTile({
  index, source, x, y, size, selected, images, onOpen, onCycle, onLongPress, check, selectMode,
}: {
  index: number; source?: ImageSourcePropType; x: number; y: number; size: number; selected?: boolean; images?: boolean;
  onOpen?: (i: number) => void; onCycle?: (i: number) => void; onLongPress?: (i: number) => void; check?: boolean | null; selectMode?: boolean;
}) {
  return (
    <Pressable onPress={() => onOpen?.(index)} onLongPress={onLongPress ? () => onLongPress(index) : undefined} delayLongPress={350} style={{ position: 'absolute', left: x, top: y, width: size, height: size }}>
      <View style={{ flex: 1, borderRadius: 2, overflow: 'hidden' }}>
        {images && source ? (
          <ExpoImage source={source} contentFit="cover" cachePolicy="memory-disk" style={{ width: '100%', height: '100%' }} />
        ) : (
          <View style={{ flex: 1, backgroundColor: '#3A3A3A' }} />
        )}
      </View>
      {selected ? (
        <>
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2, borderWidth: 3, borderColor: color.dark1A }} />
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2, borderWidth: 2, borderColor: screen.olive.primary }} />
          {/* uchwyt 2× — trójkąt w prawym-dolnym rogu (jak w feedzie); ukryty w trybie zaznaczania */}
          {!selectMode && onCycle ? (
            <Pressable onPress={() => onCycle(index)} hitSlop={8} style={{ position: 'absolute', right: 3, bottom: 3, padding: 3 }}>
              <Svg width={12} height={12}><Polygon points="0,12 12,0 12,12" fill={screen.olive.primary} /></Svg>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {/* badge AI / RAW (prawy-górny róg) — flagi ze źródła zdjęcia */}
      {images && source && ((source as any).ai || (source as any).raw) ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 6, right: 8, flexDirection: 'row', gap: 6 }}>
          {(source as any).ai ? <Text style={badgeTxt}>AI</Text> : null}
          {(source as any).raw ? <Text style={badgeTxt}>RAW</Text> : null}
        </View>
      ) : null}
      {check != null ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, borderRadius: 3, borderWidth: 2, borderColor: screen.olive.primary, backgroundColor: check ? color.dark21 : screen.olive.primary }} />
      ) : null}
    </Pressable>
  );
});
const badgeTxt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.primary, textShadowColor: color.dark21, textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } } as const;

export const MomentsGrid = memo(forwardRef<MomentsGridHandle, MomentsGridProps>(function MomentsGrid({
  data, timeOf, placeOf, width, selected, hideCursor, images = true, onOpen, onSelectAt, onScrollActive, spanOf, onCycleSpan, selectMode, checkedAt, onLongPressAt,
}: MomentsGridProps, ref) {
  const gap = MOMENTS_GAP;
  const cols = MOMENTS_COLS;
  const tile = (width - gap * (cols - 1)) / cols;
  const step = tile + gap; // pitch wiersza zdjęć

  // Layout: każda grupa dnia = nagłówek + PAKOWANIE per grupa (packFeed z cols=3), bo jedno zdjęcie
  // może być 2× (blok 2×2 w siatce 3-kolumnowej, reszta backfilluje dziury). `pos[i]` = pozycja + k kafla.
  // `cellGrid[g]` = mapa komórka(r,c)→indeks (blok k×k wypełniony tym samym indeksem) do NAWIGACJI.
  const { rows, totalH, pos, cells, meta } = useMemo(() => {
    const out: Row[] = [];
    const position = new Array<{ x: number; y: number; k: number } | undefined>(data.length);
    const cellByGroup: number[][][] = []; // cellByGroup[g][r][c] = indeks
    const metaByIdx = new Array<{ g: number; r: number; c: number; k: number } | undefined>(data.length);
    let y = 0;
    let i = 0;
    let g = -1;
    while (i < data.length) {
      const t0 = timeOf(i) ?? 0;
      const day = dayKey(t0);
      out.push({ kind: 'header', y, label: dayLabel(t0), place: placeOf?.(i) });
      y += HEADER_H;
      g++;
      // zbierz indeksy tego dnia
      const idxs: number[] = [];
      while (i < data.length && dayKey(timeOf(i) ?? 0) === day) { idxs.push(i); i++; }
      const spans = idxs.map((ix) => Math.min(Math.max(spanOf?.(ix) ?? 1, 1), cols));
      const { pos: local, rows: gr } = packFeed(spans, cols);
      const grid: number[][] = [];
      const groupY = y;
      idxs.forEach((ix, j) => {
        const p = local[j];
        position[ix] = { x: p.c * step, y: groupY + p.r * step, k: p.k };
        metaByIdx[ix] = { g, r: p.r, c: p.c, k: p.k };
        for (let dr = 0; dr < p.k; dr++) { const rr = grid[p.r + dr] || (grid[p.r + dr] = []); for (let dc = 0; dc < p.k; dc++) rr[p.c + dc] = ix; }
      });
      cellByGroup.push(grid);
      y += gr * step;
    }
    return { rows: out, totalH: y, pos: position, cells: cellByGroup, meta: metaByIdx };
  }, [data, timeOf, placeOf, spanOf, step, cols]);

  const scrollRef = useRef<ScrollView>(null);
  const [viewH, setViewH] = useState(0);
  const [win, setWin] = useState({ top: 0, bottom: 0 });
  const curY = useRef(0);
  const userScrolling = useRef(false);
  const settleT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutoOnce = useRef(false);
  const selRef = useRef(selected); selRef.current = selected;

  const cbRef = useRef({ onOpen, onLongPressAt, onCycleSpan });
  cbRef.current = { onOpen, onLongPressAt, onCycleSpan };
  const openTile = useCallback((i: number) => cbRef.current.onOpen(i), []);
  const longTile = useCallback((i: number) => cbRef.current.onLongPressAt?.(i), []);
  const cycleTile = useCallback((i: number) => cbRef.current.onCycleSpan?.(i), []);

  const setWindow = (y: number, vh: number) => { const buf = step * 3; setWin({ top: y - buf, bottom: y + vh + buf }); };

  const scrollToY = (y: number, animated: boolean) => {
    const maxY = Math.max(0, totalH - viewH);
    const target = Math.max(0, Math.min(maxY, y));
    curY.current = target; setWindow(target, viewH);
    try { scrollRef.current?.scrollTo({ y: target, animated }); } catch {}
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    curY.current = y;
    if (Math.abs(y - win.top - step * 3) >= step) setWindow(y, viewH);
  };
  const onScrollBeginDrag = () => { userScrolling.current = true; onScrollActive?.(true); if (settleT.current) clearTimeout(settleT.current); };
  // Po zatrzymaniu swipe kursor ląduje na PIERWSZYM OD LEWEJ (kol 0) kaflu wiersza w pionowym ŚRODKU
  // ekranu — widok jest wyrównany do lewej, więc lewa kolumna jest naturalnym miejscem kursora.
  const settle = () => {
    userScrolling.current = false;
    onScrollActive?.(false);
    if (!onSelectAt || viewH <= 0) return;
    const centerY = curY.current + viewH / 2;
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]; if (!p) continue;
      const th = p.k * tile + (p.k - 1) * gap;
      const d = Math.abs(p.y + th / 2 - centerY);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best < 0) return;
    const m = meta[best];
    const target = m ? (cells[m.g]?.[m.r]?.[0] ?? best) : best; // kol 0 wiersza pod środkiem
    if (target !== selRef.current) { skipAutoOnce.current = true; onSelectAt(target); }
  };
  const onScrollEndDrag = () => { if (settleT.current) clearTimeout(settleT.current); settleT.current = setTimeout(settle, 120); };
  const onMomentumScrollEnd = () => { if (settleT.current) clearTimeout(settleT.current); settle(); };
  const onLayout = (e: LayoutChangeEvent) => { const h = e.nativeEvent.layout.height; setViewH(h); setWindow(curY.current, h); };

  // scroll-into-view kursora: widok stoi, dopóki zaznaczony kafel mieści się w kadrze (wraz z jego
  // nagłówkiem, żeby po skoku na nowy dzień było widać jego etykietę).
  const didScroll = useRef(false);
  useEffect(() => {
    const p = pos[selected];
    if (!p || viewH <= 0) return;
    if (userScrolling.current) return;
    if (skipAutoOnce.current) { skipAutoOnce.current = false; return; }
    const first = !didScroll.current; didScroll.current = true;
    // WYPRZEDZENIE o jeden wiersz (jak w FOLDERS/FEED) — dosuwaj, zanim kafel dotknie krawędzi.
    const lead = step;
    let target: number | null = null;
    const th = p.k * tile + (p.k - 1) * gap;
    if (first) target = Math.max(0, p.y + th / 2 - viewH / 2);
    else if (p.y - lead < curY.current) target = p.y - HEADER_H - lead; // zbliża się do góry → zapas wiersza (+ nagłówek)
    else if (p.y + th + lead > curY.current + viewH) target = p.y + th - viewH + gap + lead;
    if (target == null) return;
    scrollToY(target, !first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, viewH]);
  useEffect(() => () => { if (settleT.current) clearTimeout(settleT.current); }, []);

  // NAWIGACJA GRUPOWA (joystick). W poziomie: sąsiedni kafel (±1) w kolejności czytania. W pionie:
  //   • w obrębie grupy — o jeden wiersz, zachowując kolumnę (jak siatka);
  //   • na krawędzi grupy — WYJŚCIE: skok na PIERWSZY OD LEWEJ (kol 0) najbliższego wiersza sąsiedniej grupy
  //     (w dół → pierwszy wiersz następnej grupy; w górę → ostatni wiersz poprzedniej).
  const go = (idx: number) => { if (idx != null && idx !== selRef.current && onSelectAt) { skipAutoOnce.current = false; onSelectAt(idx); } };
  const cellAt = (g: number, r: number, c: number): number | undefined => cells[g]?.[r]?.[Math.min(c, (cells[g]?.[r]?.length ?? 1) - 1)];
  const moveH = (dir: -1 | 1) => go(Math.max(0, Math.min(data.length - 1, selRef.current + dir)));
  const moveV = (dir: -1 | 1) => {
    const m = meta[selRef.current]; if (!m) return;
    if (dir < 0) {
      if (m.r > 0) { const t = cellAt(m.g, m.r - 1, m.c); if (t != null) go(t); }        // wiersz wyżej w grupie (cellGrid wypełnia blok 2× → trafia na kafel)
      else if (m.g > 0) { const pg = cells[m.g - 1]; go(cellAt(m.g - 1, pg.length - 1, 0)!); } // wyjście: ostatni wiersz poprzedniej grupy, kol 0
    } else {
      const below = m.r + m.k; // pod kaflem (2× zajmuje r..r+k-1)
      if (cells[m.g]?.[below]) { const t = cellAt(m.g, below, m.c); if (t != null) go(t); }
      else if (m.g < cells.length - 1) { go(cellAt(m.g + 1, 0, 0)!); }                  // wyjście: pierwszy wiersz następnej grupy, kol 0
    }
  };
  const navApi = useRef({ moveH, moveV }); navApi.current = { moveH, moveV };
  useImperativeHandle(ref, () => ({
    moveH: (d: -1 | 1) => navApi.current.moveH(d),
    moveV: (d: -1 | 1) => navApi.current.moveV(d),
  }), []);

  return (
    <ScrollView
      ref={scrollRef}
      scrollEventThrottle={32}
      onScrollBeginDrag={onScrollBeginDrag}
      onScroll={onScroll}
      onScrollEndDrag={onScrollEndDrag}
      onMomentumScrollEnd={onMomentumScrollEnd}
      onLayout={onLayout}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, alignSelf: 'stretch' }}
    >
      <View style={{ height: totalH }}>
        {/* nagłówki dat */}
        {rows.map((r, ri) => {
          if (r.y > win.bottom || r.y + HEADER_H < win.top) return null;
          return (
            <View key={`h${ri}`} style={{ position: 'absolute', left: 0, right: 0, top: r.y, height: HEADER_H, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: screen.olive.primary, textShadowColor: 'rgba(226,255,228,0.25)', textShadowRadius: 4 }}>{r.label}</Text>
              {r.place ? <Text style={{ fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.secondary }}>{r.place}</Text> : null}
            </View>
          );
        })}
        {/* kafle (osobno od nagłówków, bo 2× łamie prosty podział na wiersze) */}
        {data.map((src, i) => {
          const p = pos[i];
          if (!p) return null;
          const size = p.k * tile + (p.k - 1) * gap;
          if (p.y > win.bottom || p.y + size < win.top) return null; // poza oknem
          return (
            <MomentTile
              key={i}
              index={i}
              source={src}
              x={p.x}
              y={p.y}
              size={size}
              selected={i === selected && !hideCursor}
              images={images}
              onOpen={openTile}
              onCycle={cycleTile}
              onLongPress={onLongPressAt ? longTile : undefined}
              check={selectMode ? !!checkedAt?.(i) : undefined}
              selectMode={selectMode}
            />
          );
        })}
      </View>
    </ScrollView>
  );
}));
