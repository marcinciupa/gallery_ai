/**
 * Design tokens — przepisane 1:1 z Figmy (REC_AI / base, node 161:12287).
 * Źródło: globalVars.styles z get_figma_data. Konwencja: prozą po polsku, kod po angielsku.
 *
 * Gradienty trzymamy jako { colors, start, end } pod expo-linear-gradient.
 * start/end to handle gradientu w przestrzeni obiektu: (0,0)→(1,1) = od rogu
 * do przeciwległego rogu (W,H), kierunek zależny od proporcji elementu (jak w Figmie).
 * Kierunki CSS → punkty: 135deg = TL→BR (0,0)->(1,1); -45deg = BL→TR (0,1)->(1,0).
 */

export type Gradient = {
  colors: [string, string, ...string[]];
  locations?: number[];
  start: { x: number; y: number };
  end: { x: number; y: number };
};

const DIR_135 = { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } };
const DIR_N45 = { start: { x: 0, y: 1 }, end: { x: 1, y: 0 } };

// Bevel dwuwarstwowy (Figma 121:269/122:414/122:688): obrys per-strona, pół-przezroczysty → theme-agnostic.
// colors[0] = LIGHT (góra+lewo), colors[1] = SHADOW (dół+prawo). RAISED=wypukły, RECESSED=wklęsły (odwrotnie).
const BEVEL_LIGHT = 'rgba(255,255,255,0.25)';
const BEVEL_SHADOW = 'rgba(33,33,33,0.25)'; // #212121 @ 25%
const RAISED: Gradient = { colors: [BEVEL_LIGHT, BEVEL_SHADOW], ...DIR_135 };
const RECESSED: Gradient = { colors: [BEVEL_SHADOW, BEVEL_LIGHT], ...DIR_135 };

export const color = {
  white: '#FFFFFF',
  gray: '#898989', // ikony, etykiety 10X (fill_Y7GXBY)
  grayMid: '#8B8B8B',
  metal: '#BABABA', // korpusy przycisków metal / knob (fill_VL0WBT)
  metalLight: '#D7D8D7',
  dark0: '#0D0D0D',
  dark1A: '#1A1A1A',
  dark1B: '#1B1B1B',
  dark21: '#212121',
  dark24: '#242424',
  phosphor: '#E2FFE4', // tekst na przyciskach "screen" (fill_6UZTL2)
  recordRed: '#FF4C4C', // dioda record (fill_U0SF11)
  recordRedHot: '#FF2727',
} as const;

export const gradient = {
  /** Tło aplikacji / poza obudową (fill_I90ATF) */
  appBg: { colors: ['#0B0B0B', '#1A1A1A'], ...DIR_135 } as Gradient,
  /** Metal obudowy (fill_LE9E3O — pod teksturą brushed-metal) */
  bodyMetal: { colors: ['#D7D8D7', '#BABABA'], ...DIR_135 } as Gradient,
  /** Bevel obudowy (raised, subtelny dwustronny — jak klawisze; działa na każdym motywie) */
  bodyStroke: RAISED,
  /** Ciemna powierzchnia: grille, ramka ekranu, button_gap (fill_HSHAQN) */
  darkSurface: { colors: ['#1A1A1A', '#212121'], ...DIR_135 } as Gradient,
  /** Bevel kropek grille (fill_5KO435) */
  dotStroke: { colors: ['#898989', '#FFFFFF'], ...DIR_135 } as Gradient,
  /** Połysk szyby ekranu (fill_QSEJOV — nad #1A1A1A) */
  screenSheen: {
    colors: ['rgba(255,255,255,0.5)', 'rgba(153,153,153,0)'],
    ...DIR_135,
  } as Gradient,
  /** Bevel metaliczny "ostry" 45/55 — button_gap (fill_7UYWSR) */
  bevelSharp: {
    colors: ['#BABABA', '#D7D8D7'],
    locations: [0.45, 0.55],
    ...DIR_135,
  } as Gradient,
  /** Bevel metaliczny biały→szary 45/55 — small button / knob (fill_6VM2QO) */
  bevelButton: {
    colors: ['#FFFFFF', '#898989'],
    locations: [0.45, 0.55],
    ...DIR_135,
  } as Gradient,
  /** Rowek slidera (slider_gap, fill_DOENYW — widoczna górna warstwa: ciemna).
   *  Wcześniej brana była dolna, ukryta warstwa (#828282→#ACACAC) → rowek był za jasny. */
  sliderGroove: { colors: ['#1A1A1A', '#212121'], ...DIR_135 } as Gradient,
  /** Tor slidera — obrys (wklęsły) */
  sliderTrackStroke: RECESSED,
  /** Tło klawiatury (fill_YXY174) */
  keyboard: { colors: ['#000000', '#1B1B1B'], ...DIR_135 } as Gradient,
  /** Bevel klawiatury — wklęsła rama */
  keyboardStroke: RECESSED,
  /** Tło przycisku "screen" — połysk nad #1A1A1A (fill_Z70GUV).
   *  Peak 0.4 (był 0.25) = zapas jasności; ScreenSheen modeluje opacity wg wychylenia
   *  (spoczynek ~0.24, pełny tilt 0.4 → widoczny ruch połysku z akcelerometru). */
  keyScreen: {
    colors: ['rgba(255,255,255,0.4)', 'rgba(255,255,255,0)'],
    ...DIR_135,
  } as Gradient,
  /** Bevel przycisku "screen" — lekko wypukły */
  keyScreenStroke: RAISED,
  /** Połysk diody record nad czerwienią (fill_U0SF11, górna warstwa) */
  recordSheen: { colors: ['#000000', '#414141'], ...DIR_135 } as Gradient,
} as const;

/**
 * Motywy obudowy (node 161:12291). Każdy motyw przebarwia wszystkie elementy
 * "metalowe"/nadrukowane na obudowie; ekran (szyba+phosphor) i ciemne wnęki są stałe.
 *  - bodyMetal     korpus (pod teksturą)
 *  - metal         wypełnienie metalowych korpusów (przyciski/knob/seek)
 *  - raisedBevel   obrys wypukłych (przyciski metalowe/knob/seek) — jasno L-góra→ciemno P-dół
 *  - recessedBevel obrys wklęsłych (rama klawiatury, otwory mikrofonu) — odwrotnie
 *  - pocketBevel   obrys kieszeni seek (button_gap)
 *  - printed       kolor nadruków na obudowie (10X, strzałki, logo)
 */
export type ThemeName = 'LIGHT' | 'DARK' | 'ORANGE' | 'NAVY';
export type ThemePalette = {
  bodyMetal: Gradient;
  metal: string;
  raisedBevel: Gradient;
  recessedBevel: Gradient;
  pocketBevel: Gradient;
  printed: string;
  /** kolor napisu na metalowym przycisku: aktywny / wygaszony (Button Active/Inactive) */
  buttonActive: string;
  buttonInactive: string;
  /** dioda record (Body Red) */
  recordRed: string;
  /** poświata / cień (Glow / Shadow) — do wytłoczeń (knob, miska record) */
  glow: string;
  shadow: string;
  /** czy korpus jest ciemny (DARK/NAVY) — np. jasne ikony status bara */
  casingDark: boolean;
};

/** Cień wypukłej miski (record) i knoba — kierunkowy: cień P-dół, poświata L-góra. */
export const elevationShadow = (t: ThemePalette) =>
  `2px 2px 4px 0px ${t.shadow}, -2px -2px 4px 0px ${t.glow}`;
export const knobShadow = (t: ThemePalette) =>
  `8px 8px 6px 0px ${t.shadow}, -8px -8px 10px 0px ${t.glow}`;

/**
 * Kolory treści ekranu (szyba) — STAŁE we wszystkich motywach (tokens.json:
 * Screen *). Dwie rodziny: olive (phosphor green) i red, każda primary/secondary/
 * inactive/off (kryjka 100/50/25/0%).
 */
export const screen = {
  bg: '#1A1A1A', // Screen Background
  glow: 'rgba(255,255,255,0.25)', // Screen Glow (#ffffff40)
  olive: {
    primary: '#E2FFE4',
    secondary: 'rgba(226,255,228,0.5)',
    inactive: 'rgba(226,255,228,0.25)',
    off: 'rgba(226,255,228,0)',
  },
  red: {
    primary: '#FF4C4C',
    secondary: 'rgba(255,76,76,0.5)',
    inactive: 'rgba(255,76,76,0.25)',
    off: 'rgba(255,76,76,0)',
  },
} as const;

const grad = (a: string, b: string): Gradient => ({ colors: [a, b], ...DIR_135 });
const bevel = (a: string, b: string): Gradient => ({ colors: [a, b], locations: [0.45, 0.55], ...DIR_135 });

export const themes: Record<ThemeName, ThemePalette> = {
  LIGHT: {
    bodyMetal: grad('#D7D8D7', '#BABABA'),
    metal: '#BABABA',
    raisedBevel: RAISED,
    recessedBevel: RECESSED,
    pocketBevel: RECESSED,
    printed: '#898989',
    buttonActive: '#FFFFFF',
    buttonInactive: '#898989',
    recordRed: '#FF4C4C',
    glow: 'rgba(255,255,255,0.25)',
    shadow: 'rgba(26,26,26,0.05)',
    casingDark: false,
  },
  DARK: {
    bodyMetal: grad('#323232', '#212121'),
    metal: '#484848',
    raisedBevel: RAISED,
    recessedBevel: RECESSED,
    pocketBevel: RECESSED,
    printed: '#898989',
    buttonActive: '#FFFFFF',
    buttonInactive: '#1A1A1A',
    recordRed: '#FF4C4C',
    glow: 'rgba(255,255,255,0.05)',
    shadow: 'rgba(26,26,26,0.25)',
    casingDark: true,
  },
  ORANGE: {
    bodyMetal: grad('#E95728', '#E44F25'),
    metal: '#C62C24',
    raisedBevel: RAISED,
    recessedBevel: RECESSED,
    pocketBevel: RECESSED,
    printed: '#C92B22',
    buttonActive: '#FFBF3E',
    buttonInactive: '#AA2019',
    recordRed: '#F1B28B',
    glow: 'rgba(198,44,36,0.05)',
    shadow: 'rgba(116,49,38,0.25)',
    casingDark: false,
  },
  NAVY: {
    bodyMetal: grad('#1A3557', '#0D1726'),
    metal: '#29416A',
    raisedBevel: RAISED,
    recessedBevel: RECESSED,
    pocketBevel: RECESSED,
    printed: '#3A5A82',
    buttonActive: '#446DA0',
    buttonInactive: '#1A1A1A',
    recordRed: '#FF4C4C',
    glow: 'rgba(28,43,69,0.05)',
    shadow: 'rgba(8,14,26,0.25)',
    casingDark: true,
  },
};

/** Cienie w formacie CSS boxShadow (RN 0.85+ wspiera string boxShadow, web też). */
export const shadow = {
  screenInset: 'inset 0px 0px 12px 0px rgba(255,255,255,0.05)', // effect_ICS64H
  knob: '8px 8px 6px 0px rgba(26,26,26,0.05), -8px -8px 10px 0px rgba(255,255,255,0.25)', // effect_WGLK22
  knobGripInset: 'inset 0.5px 0.5px 1px 0px rgba(0,0,0,0.1)', // effect_VM2CYE
  keyInsetReduction:
    'inset 2px 2px 4px 0px rgba(0,0,0,0.15), inset -2px -2px 4px 0px rgba(255,255,255,0.05)', // effect_XJRBIA
  keyElevation:
    '2px 2px 4px 0px rgba(26,26,26,0.05), -2px -2px 4px 0px rgba(255,255,255,0.25)', // effect_79VALX
  recordGlow: '0px 0px 4px 0px rgba(255,76,76,0.25)', // effect_HUNIJC
} as const;

/** Cienie tekstu (phosphor / metal labels). */
export const textShadow = {
  phosphor: { color: 'rgba(226,255,228,0.25)', radius: 4 }, // effect_W32JQ6
  whiteGlow: { color: 'rgba(255,255,255,0.25)', radius: 4 }, // effect_I10K5J
} as const;

/** Wymiary i layout (1:1 z layout_*). */
export const dims = {
  frame: { width: 390, height: 844 },
  bodyRadius: { tl: 8, tr: 8, br: 32, bl: 32 },
  statusBarHeight: 40,
  upperMicHeight: 40,
  screenPadding: 16,
  screenGap: 16,
  screenRadius: 4,
  screenFramePadding: 2,
  sliderHeight: 48,
  sliderPadding: 16,
  sliderGap: 8,
  // GALERIA: klawiatura = JEDEN rząd × 5 (BUTTON_1 · PREV · JOYSTICK · NEXT · BUTTON_2).
  // width = 5×64 + 4×gap(2) + 2×padding(2) = 332; height = 64 + 2×padding(2) = 68. (rozjazd vs rec_ai 2×3)
  keyboard: { width: 332, height: 68, padding: 2, gap: 2, radius: 6 },
  keyboardAreaHeight: 106,
  key: { size: 64, padding: 8, radius: 4 },
  keyInner: { size: 48, offset: 8, radius: 24 },
  // JOYSTICK (nowy, node 350:4682): metalowy kwadrat 64 → wklęsła studnia 56 (offset 4) → wypukły grzybek 24.
  joystick: { size: 64, well: 56, wellOffset: 4, wellRadius: 28, nub: 24, nubTravel: 10, dirThreshold: 12 },
  smallButton: { width: 32, height: 20, radius: 4, padding: 4 },
  knob: { width: 64, height: 20, radius: 4 },
} as const;

export const font = {
  // UI/Label MD — Inter Medium 12 (STOP, PLAY, 10X, nagłówki sekcji)
  uiLabel: { family: 'Inter_500Medium', size: 14 },
  // Mono/Label — Kode Mono Bold 10 (etykiety przycisków "screen")
  monoLabel: { family: 'KodeMono_700Bold', size: 12 },
  // Mono/Caption — Kode Mono Regular 8 (label pomocniczy przycisku, np. [CLOSE])
  monoCaption: { family: 'KodeMono_400Regular', size: 10 },
  // UI/Body LG Bold — Inter Bold 16 (tytuł ekranu w pigułce, np. SETTINGS)
  bodyLgBold: { family: 'Inter_700Bold', size: 16 },
  // Mono/Body — Kode Mono Regular 14 (etykieta wiersza ustawień)
  monoBody: { family: 'KodeMono_400Regular', size: 14 },
  // Mono/Heading — Kode Mono Regular 18 (wartość wiersza: ON/OFF/DARK)
  monoHeading: { family: 'KodeMono_400Regular', size: 18 },
  // UI/Caption — Inter Regular 10 (STEREO/UHQ)
  caption: { family: 'Inter_400Regular', size: 10 },
  // UI/Caption Bold — Inter Bold 10 (L / R)
  captionBold: { family: 'Inter_700Bold', size: 10 },
  // Timer nagrywania — Mono/Display XL = Kode Mono 42
  timer: { family: 'KodeMono_400Regular', size: 42 },
} as const;
