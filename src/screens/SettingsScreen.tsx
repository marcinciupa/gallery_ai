/**
 * SettingsScreen (galeria, node 352:5107 device/fullscreen). `useSettingsScreen()` zwraca treść
 * (slot Display) + kontekstową klawiaturę. Nawigację prowadzi JOYSTICK (4-kier.):
 *   góra/dół   = ruch zaznaczenia między wierszami
 *   lewo/prawo = zmiana wartości (cykl opcji)
 *   press      = zatwierdź (następna opcja)
 * Klawisze krawędziowe 1 i 5 = jak 1 i 3 w rec_ai: #1 kontekstowo zmienia wartość zaznaczonego
 * wiersza (label pokazuje docelową wartość), #5 = NEXT (następny wiersz). PREV/NEXT (metal) — placeholdery.
 *
 * Sekcje: GALLERY / VIEWER / OTHER. Funkcjonalne wiersze (KEEP SCREEN ON, FULLSCREEN, LEFT-HANDED
 * MODE, THEME) sterują obudową; SETTING 1/2/3 to inertne placeholdery odwzorowujące mock z Figmy.
 */
import { ReactNode, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { color, font, screen, textShadow, ThemeName } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';
import { ScreenTopBar, Mode, DisplayMode } from './ScreenChrome';
import { Diag } from '../lib/diag';
import { APP_VERSION } from '../version';

const SETTINGS_KEY = 'galleryai.settings.v1'; // trwałość ustawień (AsyncStorage; web=localStorage)

// długie pojedyncze słowa na labelach klawiszy → ręczny podział na 2 linie z dywizem (jak w rec_ai)
const KEY_WRAP: Record<string, string> = { IMMERSIVE: 'IMMER-\nSIVE' };
const keyWrap = (s: string) => KEY_WRAP[s] ?? s;

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

/** Nagłówek sekcji — wyśrodkowany, phosphor. */
function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{ fontFamily: font.uiLabel.family, fontSize: font.uiLabel.size, color: screen.olive.primary, textAlign: 'center', ...phosphorGlow }}
    >
      {children}
    </Text>
  );
}

/** Wiersz ustawienia: etykieta (mono, lewo) + wartość (mono większa, prawo). `selected` = tło phosphor + ciemny tekst. */
function Row({
  label,
  value,
  selected = false,
  locked = false,
  onPress,
  innerRef,
}: {
  label: string;
  value: string;
  selected?: boolean;
  locked?: boolean;
  onPress?: () => void;
  innerRef?: (node: View | null) => void;
}) {
  const fg = selected ? color.dark21 : screen.olive.primary;
  const glow = selected ? null : phosphorGlow;
  const valueColor = locked ? screen.olive.inactive : fg;
  return (
    <Pressable
      ref={innerRef as any}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: 24,
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 2,
        backgroundColor: selected ? screen.olive.primary : 'transparent',
      }}
    >
      <Text style={{ flex: 1, fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: fg, ...glow }}>{label}</Text>
      <Text
        style={{ fontFamily: font.monoHeading.family, fontSize: font.monoHeading.size, color: valueColor, textAlign: 'right', ...(locked ? null : glow) }}
      >
        {value}
      </Text>
    </Pressable>
  );
}

function Section({ header, children }: { header: string; children: ReactNode }) {
  return (
    <View style={{ alignSelf: 'stretch', gap: 8 }}>
      <SectionHeader>{header}</SectionHeader>
      {children}
    </View>
  );
}

const redGlow = { textShadowColor: 'rgba(255,76,76,0.25)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 0 } } as const;

/** Wiersz folderu w edytorze filtra: nazwa (mono, lewo) + akcja ADD/REMOVE (prawo). `member` = należy do
 *  zbioru (included/excluded). `selected` = kursor joysticka (tło phosphor). Tap w akcję przełącza; tap w
 *  wiersz zaznacza. REMOVE czerwony (usuwa ze zbioru), ADD phosphor (dodaje). */
function FolderFilterRow({ name, member, selected, onPress, onToggle, innerRef }: { name: string; member?: boolean; selected?: boolean; onPress?: () => void; onToggle?: () => void; innerRef?: (node: View | null) => void }) {
  const fg = selected ? color.dark21 : screen.olive.primary;
  const glow = selected ? null : phosphorGlow;
  const action = member ? 'REMOVE' : 'ADD';
  const actionColor = selected ? color.dark1A : member ? color.recordRed : screen.olive.primary;
  return (
    <Pressable
      ref={innerRef as any}
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: 24, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 2, backgroundColor: selected ? screen.olive.primary : 'transparent' }}
    >
      <Text style={{ flex: 1, fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: fg, ...glow }}>{name}</Text>
      <Pressable onPress={onToggle} hitSlop={8}>
        <Text style={{ fontFamily: font.monoHeading.family, fontSize: font.monoHeading.size, color: actionColor, ...(selected ? null : member ? redGlow : phosphorGlow) }}>{action}</Text>
      </Pressable>
    </Pressable>
  );
}

// `action` = wiersz-akcja (nie cykluje wartości, tylko otwiera sub-widok, np. EXCLUDED FOLDERS)
type Item = { label: string; options: string[]; value: number; locked?: boolean; action?: boolean };
type SectionData = { header: string; items: Item[] };

/** Stan początkowy ustawień. Placeholdery usunięte — sekcja DIAG (tymczasowa) wypełnia listę do testów. */
const INITIAL_SECTIONS: SectionData[] = [
  {
    header: 'GALLERY',
    items: [
      { label: 'KEEP SCREEN ON', options: ['OFF', 'ON'], value: 1 },
    ],
  },
  {
    header: 'LIBRARY',
    items: [
      // wiersze-akcje: otwierają edytory filtra biblioteki (realne foldery)
      { label: 'INCLUDED FOLDERS', options: ['OPEN'], value: 0, action: true },
      { label: 'EXCLUDED FOLDERS', options: ['OPEN'], value: 0, action: true },
      { label: 'HIDDEN FOLDERS', options: ['OPEN'], value: 0, action: true },
    ],
  },
  {
    header: 'VIEWER',
    items: [
      // tryb wyświetlania treści (§11b.1) — steruje filtrem miniatur/zdjęć w galerii
      { label: 'SCREEN', options: ['IMMERSIVE', 'RETRO', 'CLEAN'], value: 0 },
    ],
  },
  {
    header: 'EDIT',
    items: [
      // prompt booster: przed edycją AI ulepszamy prompt użytkownika (stub)
      { label: 'PROMPT BOOSTER', options: ['INACTIVE', 'ACTIVE'], value: 0 },
    ],
  },
  {
    header: 'OTHER',
    items: [
      { label: 'FULLSCREEN', options: ['OFF', 'ON'], value: 1 }, // DOMYŚLNIE ON (fullscreen)
      { label: 'LEFT-HANDED MODE', options: ['OFF', 'ON'], value: 0 },
      { label: 'THEME', options: ['LIGHT', 'DARK', 'ORANGE', 'NAVY'], value: 1 }, // DOMYŚLNIE DARK
      { label: 'DISPLAY MATRIX', options: ['OFF', 'ON'], value: 1 }, // matryca ekranu (przeniesione z DIAGNOSTICS)
    ],
  },
  // DIAGNOSTYKA (ukryta pod 10× tapnięciem w stopkę) — runtime'owy bisect janku; wyłączaj podsystemy.
  {
    header: 'DIAGNOSTICS',
    items: [
      { label: 'PERFORMANCE HUD', options: ['OFF', 'ON'], value: 0 }, // licznik JS FPS (przeniesione z OTHER)
      { label: 'GESTURES', options: ['OFF', 'ON'], value: 1 }, //  responder pinch/swipe
      { label: 'GRID', options: ['OFF', 'ON'], value: 1 }, //      siatka miniatur (FlatList)
      { label: 'FILTER', options: ['OFF', 'ON'], value: 1 }, //    filtr ekranowy (blend)
      { label: 'IMAGES', options: ['OFF', 'ON'], value: 1 }, //    expo-image w kaflach
      { label: 'GLOW', options: ['OFF', 'ON'], value: 1 }, //      poświata ekranu
      { label: 'SHEEN', options: ['OFF', 'ON'], value: 1 }, //     refleks ekranu
      { label: 'SHADOW', options: ['OFF', 'ON'], value: 1 }, //    inset shadow szyby
      { label: 'TEXTURE', options: ['OFF', 'ON'], value: 1 }, //   tekstura metalu
      { label: 'BEVELS', options: ['OFF', 'ON'], value: 1 }, //    bevele obudowy
      { label: 'CLIP', options: ['OFF', 'ON'], value: 1 }, //      zaokrąglone przycinanie tła
    ],
  },
];

const TOTAL_ITEMS = INITIAL_SECTIONS.reduce((n, s) => n + s.items.length, 0);
// DIAGNOSTICS jest OSTATNIą sekcją → jej wiersze to końcówka listy flat. Gdy ukryta, nawigacja kończy się przed nimi.
const DIAG_COUNT = INITIAL_SECTIONS.find((s) => s.header === 'DIAGNOSTICS')?.items.length ?? 0;
const SECTION_STARTS = (() => {
  const out: number[] = [];
  let acc = 0;
  for (const s of INITIAL_SECTIONS) {
    out.push(acc);
    acc += s.items.length;
  }
  return out;
})();

export function useSettingsScreen({
  mode = 'SETTINGS',
  onCycleMode,
  onBack,
  folders = [],
  included = [],
  excluded = [],
  hidden = [],
  onToggleIncluded,
  onToggleExcluded,
  onToggleHidden,
}: {
  mode?: Mode;
  onCycleMode?: () => void;
  onBack?: () => void; // BACK (klawisz 1) w widoku MAIN → powrót do GALLERY
  folders?: { id: string; name: string }[];
  included?: string[];
  excluded?: string[];
  hidden?: string[];
  onToggleIncluded?: (id: string) => void;
  onToggleExcluded?: (id: string) => void;
  onToggleHidden?: (id: string) => void;
} = {}) {
  const [sections, setSections] = useState<SectionData[]>(INITIAL_SECTIONS);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<'MAIN' | 'INCLUDED' | 'EXCLUDED' | 'HIDDEN'>('MAIN'); // sub-widoki edytora filtra biblioteki
  const [libSel, setLibSel] = useState(0); // kursor w liście folderów sub-widoku
  const [showDiag, setShowDiag] = useState(false); // sekcja DIAGNOSTICS ukryta; odkrywa 10× tapnięcie w stopkę
  const hydrated = useRef(false);
  // licznik szybkich tapnięć w stopkę (easter-egg jak „build number" w Androidzie)
  const footerTap = useRef({ count: 0, last: 0 });

  // nawigowalna liczba wierszy: gdy DIAGNOSTICS ukryta, wykluczamy jej (końcowe) wiersze
  const navTotal = showDiag ? TOTAL_ITEMS : TOTAL_ITEMS - DIAG_COUNT;
  // ukrycie DIAGNOSTICS gdy kursor był w jej wierszach → wróć na początek
  useEffect(() => { if (!showDiag) setSelected((i) => (i >= TOTAL_ITEMS - DIAG_COUNT ? 0 : i)); }, [showDiag]);

  // każde wejście w Settings → wraca na widok główny i pierwszy wiersz
  useEffect(() => {
    if (mode === 'SETTINGS') { setSelected(0); setView('MAIN'); }
  }, [mode]);

  // wczytaj zapisane wartości po starcie (mapa label→value), z poszanowaniem locked
  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY)
      .then((raw) => {
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, number>;
          setSections((prev) =>
            prev.map((sec) => ({
              ...sec,
              items: sec.items.map((it) =>
                !it.locked && Number.isInteger(saved[it.label]) && saved[it.label] >= 0 && saved[it.label] < it.options.length
                  ? { ...it, value: saved[it.label] }
                  : it
              ),
            }))
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        hydrated.current = true;
      });
  }, []);

  // zapisuj przy każdej zmianie (po hydratacji)
  useEffect(() => {
    if (!hydrated.current) return;
    const map: Record<string, number> = {};
    sections.forEach((s) => s.items.forEach((it) => (map[it.label] = it.value)));
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(map)).catch(() => {});
  }, [sections]);

  // Auto-scroll: trzymamy zaznaczony wiersz w widoku.
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const rowRefs = useRef<Map<number, View>>(new Map());
  const offsetRef = useRef(0);
  const viewportRef = useRef(0);

  const scrollToSelected = () => {
    const node = rowRefs.current.get(selected);
    if (!node || !contentRef.current || !scrollRef.current) return;
    const pad = 8;
    const lookTop = 64;
    const lookDown = 44;
    node.measureLayout(
      contentRef.current as any,
      (_x, y, _w, h) => {
        const top = offsetRef.current;
        const vh = viewportRef.current;
        if (y - pad - lookTop < top) {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - pad - lookTop), animated: true });
        } else if (vh > 0 && y + h + pad + lookDown > top + vh) {
          scrollRef.current?.scrollTo({ y: y + h + pad + lookDown - vh, animated: true });
        }
      },
      () => {}
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scrollToSelected(); }, [selected]);

  const move = (dir: -1 | 1) => setSelected((i) => (i + dir + navTotal) % navTotal);
  // stopka: 10 szybkich tapnięć (≤500 ms odstęp) → przełącz widoczność sekcji DIAGNOSTICS
  const onFooterTap = () => {
    const now = Date.now();
    const f = footerTap.current;
    f.count = now - f.last < 500 ? f.count + 1 : 1;
    f.last = now;
    if (f.count >= 10) { f.count = 0; setShowDiag((s) => !s); }
  };
  const flatItems = sections.flatMap((s) => s.items);

  // Zmiana wartości elementu o indeksie `idx` o `dir` opcji (locked → bez zmian).
  const changeAt = (idx: number, dir: -1 | 1) =>
    setSections((prev) => {
      let flat = -1;
      return prev.map((sec) => ({
        ...sec,
        items: sec.items.map((it) => {
          flat++;
          if (flat !== idx || it.locked) return it;
          const n = it.options.length;
          return { ...it, value: (it.value + dir + n) % n };
        }),
      }));
    });
  // Edytor filtra biblioteki (INCLUDED/EXCLUDED) — działa na REALnych folderach (prop `folders`).
  const openSub = (v: 'INCLUDED' | 'EXCLUDED' | 'HIDDEN') => { setLibSel(0); setView(v); };
  const goBack = () => { if (view !== 'MAIN') { setView('MAIN'); return true; } return false; };
  const isInc = view === 'INCLUDED';
  const subSet = view === 'INCLUDED' ? included : view === 'HIDDEN' ? hidden : excluded;   // aktualny zbiór (id folderów)
  const subToggle = view === 'INCLUDED' ? onToggleIncluded : view === 'HIDDEN' ? onToggleHidden : onToggleExcluded;
  const libMove = (d: -1 | 1) => setLibSel((i) => Math.max(0, Math.min(folders.length - 1, i + d)));
  const libToggle = (idx = libSel) => { const f = folders[idx]; if (f) subToggle?.(f.id); };
  const subFor = (label?: string): 'INCLUDED' | 'EXCLUDED' | 'HIDDEN' => (label === 'INCLUDED FOLDERS' ? 'INCLUDED' : label === 'HIDDEN FOLDERS' ? 'HIDDEN' : 'EXCLUDED');

  const changeBy = (dir: -1 | 1) => {
    const it = flatItems[selected];
    if (it?.action) { openSub(subFor(it.label)); return; }
    changeAt(selected, dir);
  };
  const setFullscreen = (on: boolean) =>
    setSections((prev) =>
      prev.map((sec) => ({
        ...sec,
        items: sec.items.map((it) => (it.label === 'FULLSCREEN' ? { ...it, value: on ? 1 : 0 } : it)),
      }))
    );
  // cykl trybu wyświetlania (SCREEN) w PĘTLI — np. ze swipe na ekranie galerii
  const cycleScreenMode = (dir: 1 | -1) =>
    setSections((prev) =>
      prev.map((sec) => ({
        ...sec,
        items: sec.items.map((it) =>
          it.label === 'SCREEN' ? { ...it, value: (it.value + dir + it.options.length) % it.options.length } : it
        ),
      }))
    );
  const tapRow = (idx: number) => {
    setSelected(idx);
    const it = flatItems[idx];
    if (it?.action) { openSub(subFor(it.label)); return; }
    changeAt(idx, 1);
  };

  // Helpery „po labelu" — dla dialogu powitalnego (WelcomeDialog steruje TYMI SAMYMI ustawieniami, trwale).
  const findByLabel = (label: string) => sections.flatMap((s) => s.items).find((it) => it.label === label);
  const optionOf = (label: string) => { const it = findByLabel(label); return it ? it.options[it.value] : ''; };
  const optionsOf = (label: string) => { const it = findByLabel(label); return it ? it.options : []; };
  const cycleByLabel = (label: string) =>
    setSections((prev) => prev.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (it.label === label ? { ...it, value: (it.value + 1) % it.options.length } : it)),
    })));

  // Klawisz #1 (jak w rec_ai) — kontekstowy: POKAZUJE wartość, na którą przełączy zaznaczony wiersz.
  //  • wiersz-akcja (INCLUDED/EXCLUDED FOLDERS) → OPEN (otwiera sub-widok)
  //  • przełącznik OFF/ON → TURN ON / TURN OFF (wg stanu)
  //  • wielo-opcja (SCREEN, THEME) → następna wartość, np. IMMERSIVE; supporting [CYCLE]
  // Akcja klawisza ta sama co joystick-prawo (changeBy(1)/openSub), zmienia się tylko etykieta.
  const selItem = flatItems[selected];
  const nextIdx = selItem ? (selItem.value + 1) % selItem.options.length : 0;
  const nextOpt = selItem ? selItem.options[nextIdx] : '';
  const key1Label = !selItem
    ? 'CHANGE'
    : selItem.action
      ? 'OPEN'
      : selItem.options.length === 2 && selItem.options.includes('OFF') && selItem.options.includes('ON')
        ? (selItem.options[selItem.value] === 'ON' ? 'TURN OFF' : 'TURN ON')
        : keyWrap(nextOpt);
  const key1Supporting = selItem && !selItem.action && selItem.options.length > 2 ? '[CYCLE]' : undefined;

  // Klawiatura: nawigacją steruje joystick. 1 (lewy ekranowy) = kontekstowa zmiana wartości zaznaczonego wiersza
  //   (pokazuje docelową wartość, primary), prawy = BACK (powrót do GALLERY; jak BACK w podglądzie). Klawisze 2/4 puste.
  const keyboard: KeyboardConfig = {
    screen: [
      { label: key1Label, supporting: key1Supporting, variant: 'primary', onPress: () => changeBy(1) },
      { label: 'BACK', onPress: () => { if (!goBack()) onBack?.(); } },
    ],
    metal: [{ type: 'label', upper: '' }, { type: 'label', upper: '' }],
    joystick: {
      highlighted: true,
      repeat: true, // przytrzymanie = powtarzaj (krok co 1)
      onUp: () => move(-1),
      onDown: () => move(1),
      onLeft: () => changeBy(-1),
      onRight: () => changeBy(1),
      onPress: () => changeBy(1),
    },
  };

  // Klawiatura sub-widoku (INCLUDED/EXCLUDED): TOGGLE (dodaj/usuń zaznaczony) · JOY. Nawigacja na joysticku.
  const subKeyboard: KeyboardConfig = {
    screen: [
      { label: 'TOGGLE', variant: 'primary', onPress: () => libToggle() },
      { label: '' },
    ],
    // klawisze 2/4 zostają WIDOCZNE, ale puste — prev/next tylko na joysticku (góra/dół)
    metal: [{ type: 'label', upper: '' }, { type: 'label', upper: '' }],
    joystick: { highlighted: true, repeat: true, onUp: () => libMove(-1), onDown: () => libMove(1), onPress: () => libToggle() },
  };

  const subContent = (
    <>
      <ScreenTopBar mode={mode} onCycleMode={onCycleMode} />
      <ScrollView style={{ flex: 1, alignSelf: 'stretch' }} contentContainerStyle={{ paddingHorizontal: 16 }} showsVerticalScrollIndicator={false}>
        <View style={{ alignSelf: 'stretch', gap: 8 }}>
          <SectionHeader>{`${view} FOLDERS`}</SectionHeader>
          {folders.length === 0 ? (
            <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.inactive, textAlign: 'center' }}>NO FOLDERS</Text>
          ) : (
            folders.map((f, i) => (
              <FolderFilterRow key={f.id} name={f.name} member={subSet.includes(f.id)} selected={i === libSel} onPress={() => setLibSel(i)} onToggle={() => subToggle?.(f.id)} />
            ))
          )}
          {isInc && included.length === 0 ? (
            <Text style={{ fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.inactive, textAlign: 'center' }}>EMPTY = ALL FOLDERS SHOWN</Text>
          ) : null}
        </View>
      </ScrollView>
    </>
  );

  const content = (
    <>
      <ScreenTopBar mode={mode} onCycleMode={onCycleMode} />
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, alignSelf: 'stretch' }}
        contentContainerStyle={{ gap: 24, paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          offsetRef.current = e.nativeEvent.contentOffset.y;
        }}
        onLayout={(e: LayoutChangeEvent) => {
          viewportRef.current = e.nativeEvent.layout.height;
          scrollToSelected();
        }}
      >
        <View ref={contentRef} style={{ gap: 24 }}>
          {sections.map((section, si) => {
            // DIAGNOSTICS ukryta, dopóki nie odkryta 10× tapnięciem w stopkę
            if (section.header === 'DIAGNOSTICS' && !showDiag) return null;
            return (
              <Section key={section.header} header={section.header}>
                {section.items.map((item, ii) => {
                  const flat = SECTION_STARTS[si] + ii;
                  return (
                    <Row
                      key={`${section.header}:${item.label}`}
                      innerRef={(node) => {
                        if (node) rowRefs.current.set(flat, node);
                        else rowRefs.current.delete(flat);
                      }}
                      label={item.label}
                      value={item.options[item.value]}
                      selected={flat === selected}
                      locked={item.locked}
                      onPress={() => tapRow(flat)}
                    />
                  );
                })}
              </Section>
            );
          })}

          {/* STOPKA — nazwa/wersja; 10× szybkie tapnięcie odkrywa/chowa sekcję DIAGNOSTICS (jak build number w Androidzie) */}
          <Pressable onPress={onFooterTap} style={{ alignItems: 'center', gap: 2, paddingTop: 8, paddingBottom: 4 }}>
            <Text style={{ fontFamily: font.monoHeading.family, fontSize: font.monoHeading.size, color: screen.olive.primary, ...phosphorGlow }}>GALLERY AI</Text>
            <Text style={{ fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.secondary, textAlign: 'center' }}>SKEUOMORPHIC AI GALLERY</Text>
            <Text style={{ fontFamily: font.monoCaption.family, fontSize: font.monoCaption.size, color: screen.olive.inactive, textAlign: 'center', marginTop: 2 }}>{`VERSION ${APP_VERSION}  ·  © 2026`}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </>
  );

  // Wartości sterujące obudową
  const flat = sections.flatMap((s) => s.items);
  const fsItem = flat.find((it) => it.label === 'FULLSCREEN');
  const fullscreen = fsItem ? fsItem.options[fsItem.value] === 'ON' : false;
  const themeItem = flat.find((it) => it.label === 'THEME');
  const theme = (themeItem ? themeItem.options[themeItem.value] : 'LIGHT') as ThemeName;
  const hItem = flat.find((it) => it.label === 'LEFT-HANDED MODE');
  const leftHanded = hItem ? hItem.options[hItem.value] === 'ON' : false;
  const ksoItem = flat.find((it) => it.label === 'KEEP SCREEN ON');
  const keepScreenOn = ksoItem ? ksoItem.options[ksoItem.value] === 'ON' : false;
  const scrItem = flat.find((it) => it.label === 'SCREEN');
  const screenMode = (scrItem ? scrItem.options[scrItem.value] : 'IMMERSIVE') as DisplayMode;
  const perfItem = flat.find((it) => it.label === 'PERFORMANCE HUD');
  const perfHud = perfItem ? perfItem.options[perfItem.value] === 'ON' : false;
  const pbItem = flat.find((it) => it.label === 'PROMPT BOOSTER');
  const promptBooster = pbItem ? pbItem.options[pbItem.value] === 'ACTIVE' : false;
  // DIAG: obiekt flag z sekcji DIAG (domyślnie ON, gdy brak wiersza)
  const diagVal = (label: string) => { const it = flat.find((i) => i.label === label); return it ? it.options[it.value] === 'ON' : true; };
  const diag: Diag = {
    gestures: diagVal('GESTURES'), grid: diagVal('GRID'), filter: diagVal('FILTER'), images: diagVal('IMAGES'),
    matrix: diagVal('DISPLAY MATRIX'), glow: diagVal('GLOW'), sheen: diagVal('SHEEN'), shadow: diagVal('SHADOW'),
    texture: diagVal('TEXTURE'), bevels: diagVal('BEVELS'), clip: diagVal('CLIP'),
  };

  const isSub = view !== 'MAIN';
  return {
    content: isSub ? subContent : content,
    keyboard: isSub ? subKeyboard : keyboard,
    goBack,
    fullscreen,
    setFullscreen,
    cycleScreenMode,
    optionOf,
    optionsOf,
    cycleByLabel,
    theme,
    leftHanded,
    keepScreenOn,
    screenMode,
    perfHud,
    promptBooster,
    diag,
  };
}
