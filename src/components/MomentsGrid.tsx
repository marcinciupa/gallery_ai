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

type Row =
  | { kind: 'header'; y: number; label: string; place?: string }
  | { kind: 'photos'; y: number; items: number[] }; // items = indeksy w `data`

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
  selectMode?: boolean;
  checkedAt?: (i: number) => boolean;
  onLongPressAt?: (i: number) => void;
};

const MomentTile = memo(function MomentTile({
  index, source, x, y, size, selected, images, onOpen, onLongPress, check,
}: {
  index: number; source?: ImageSourcePropType; x: number; y: number; size: number; selected?: boolean; images?: boolean;
  onOpen?: (i: number) => void; onLongPress?: (i: number) => void; check?: boolean | null;
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
        </>
      ) : null}
      {check != null ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, borderRadius: 3, borderWidth: 2, borderColor: screen.olive.primary, backgroundColor: check ? color.dark21 : screen.olive.primary }} />
      ) : null}
    </Pressable>
  );
});

export const MomentsGrid = memo(forwardRef<MomentsGridHandle, MomentsGridProps>(function MomentsGrid({
  data, timeOf, placeOf, width, selected, hideCursor, images = true, onOpen, onSelectAt, onScrollActive, selectMode, checkedAt, onLongPressAt,
}: MomentsGridProps, ref) {
  const gap = MOMENTS_GAP;
  const cols = MOMENTS_COLS;
  const tile = (width - gap * (cols - 1)) / cols;
  const step = tile + gap; // pitch wiersza zdjęć

  // Zbuduj layout: dla każdej grupy dnia nagłówek + wiersze po `cols`. `pos[i]` = pozycja kafla i.
  // Dodatkowo `groups` (grupa → wiersze → indeksy) i `meta[i]` (grupa/wiersz/kolumna) do NAWIGACJI grupowej.
  const { rows, totalH, pos, groups, meta } = useMemo(() => {
    const out: Row[] = [];
    const position = new Array<{ x: number; y: number } | undefined>(data.length);
    const grps: number[][][] = [];               // grps[g][row] = indeksy w wierszu
    const metaByIdx = new Array<{ g: number; row: number; col: number } | undefined>(data.length);
    let y = 0;
    let prevDay: string | null = null;
    let col = 0;
    let curItems: number[] = [];
    let g = -1;
    const flushPhotos = () => {
      if (curItems.length) { out.push({ kind: 'photos', y, items: curItems }); grps[g].push(curItems); y += step; curItems = []; }
    };
    for (let i = 0; i < data.length; i++) {
      const t = timeOf(i) ?? 0;
      const k = dayKey(t);
      if (k !== prevDay) {
        flushPhotos(); col = 0;
        out.push({ kind: 'header', y, label: dayLabel(t), place: placeOf?.(i) });
        y += HEADER_H;
        prevDay = k;
        g++; grps.push([]);
      }
      position[i] = { x: col * step, y };
      metaByIdx[i] = { g, row: grps[g].length, col };
      curItems.push(i);
      col++;
      if (col === cols) { flushPhotos(); col = 0; }
    }
    if (col !== 0) flushPhotos();
    return { rows: out, totalH: y, pos: position, groups: grps, meta: metaByIdx };
  }, [data, timeOf, placeOf, step, cols]);

  const scrollRef = useRef<ScrollView>(null);
  const [viewH, setViewH] = useState(0);
  const [win, setWin] = useState({ top: 0, bottom: 0 });
  const curY = useRef(0);
  const userScrolling = useRef(false);
  const settleT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutoOnce = useRef(false);
  const selRef = useRef(selected); selRef.current = selected;

  const cbRef = useRef({ onOpen, onLongPressAt });
  cbRef.current = { onOpen, onLongPressAt };
  const openTile = useCallback((i: number) => cbRef.current.onOpen(i), []);
  const longTile = useCallback((i: number) => cbRef.current.onLongPressAt?.(i), []);

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
  const settle = () => { userScrolling.current = false; onScrollActive?.(false); };
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
    if (first) target = Math.max(0, p.y + tile / 2 - viewH / 2);
    else if (p.y - lead < curY.current) target = p.y - HEADER_H - lead; // zbliża się do góry → zapas wiersza (+ nagłówek)
    else if (p.y + tile + lead > curY.current + viewH) target = p.y + tile - viewH + gap + lead;
    if (target == null) return;
    scrollToY(target, !first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, viewH]);
  useEffect(() => () => { if (settleT.current) clearTimeout(settleT.current); }, []);

  // NAWIGACJA GRUPOWA (joystick). W poziomie: sąsiedni kafel (±1) w kolejności czytania. W pionie:
  //   • w obrębie grupy — o jeden wiersz, zachowując kolumnę (jak siatka);
  //   • na krawędzi grupy — WYJŚCIE: skok na PIERWSZY OD LEWEJ (kol 0) najbliższego wiersza sąsiedniej grupy
  //     (w dół → pierwszy wiersz następnej grupy; w górę → ostatni wiersz poprzedniej).
  const go = (idx: number) => { if (idx !== selRef.current && onSelectAt) { skipAutoOnce.current = false; onSelectAt(idx); } };
  const moveH = (dir: -1 | 1) => go(Math.max(0, Math.min(data.length - 1, selRef.current + dir)));
  const moveV = (dir: -1 | 1) => {
    const m = meta[selRef.current]; if (!m) return;
    const g = groups[m.g]; if (!g) return;
    if (dir < 0) {
      if (m.row > 0) { const r = g[m.row - 1]; go(r[Math.min(m.col, r.length - 1)]); }
      else if (m.g > 0) { const pg = groups[m.g - 1]; go(pg[pg.length - 1][0]); } // ostatni wiersz poprzedniej grupy, kol 0
    } else {
      if (m.row < g.length - 1) { const r = g[m.row + 1]; go(r[Math.min(m.col, r.length - 1)]); }
      else if (m.g < groups.length - 1) { go(groups[m.g + 1][0][0]); } // pierwszy wiersz następnej grupy, kol 0
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
        {rows.map((r, ri) => {
          if (r.y > win.bottom || r.y + (r.kind === 'header' ? HEADER_H : step) < win.top) return null;
          if (r.kind === 'header') {
            return (
              <View key={`h${ri}`} style={{ position: 'absolute', left: 0, right: 0, top: r.y, height: HEADER_H, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontFamily: font.monoLabel.family, fontSize: font.monoLabel.size, color: screen.olive.primary, textShadowColor: 'rgba(226,255,228,0.25)', textShadowRadius: 4 }}>{r.label}</Text>
                {r.place ? <Text style={{ fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.secondary }}>{r.place}</Text> : null}
              </View>
            );
          }
          return r.items.map((i) => {
            const p = pos[i]!;
            return (
              <MomentTile
                key={i}
                index={i}
                source={data[i]}
                x={p.x}
                y={p.y}
                size={tile}
                selected={i === selected && !hideCursor}
                images={images}
                onOpen={openTile}
                onLongPress={onLongPressAt ? longTile : undefined}
                check={selectMode ? !!checkedAt?.(i) : undefined}
              />
            );
          });
        })}
      </View>
    </ScrollView>
  );
}));
