// DIAGNOSTYKA WYDAJNOŚCI (tymczasowe) — runtime'owe przełączniki podsystemów do bisektu janku.
// Sterowane z Settings → DIAG. Wszystko domyślnie ON = normalne działanie. Do usunięcia po diagnozie.
export type Diag = {
  gestures: boolean; // responder pinch/swipe (obudowa+ekran)
  grid: boolean; //     siatka miniatur (FlatList) — off = placeholder
  filter: boolean; //   filtr ekranowy (mixBlendMode saturation/multiply)
  images: boolean; //   expo-image w kaflach — off = zwykłe kolorowe View
  matrix: boolean; //   matryca ekranu (ScreenMatrix)
  glow: boolean; //     poświata ekranu (Glow SVG)
  sheen: boolean; //    sheen/refleks ekranu
  shadow: boolean; //   inset shadow szyby (boxShadow pełnoekranowy)
  texture: boolean; //  tekstura brushed-metal obudowy
  bevels: boolean; //   bevele obudowy (linie/krawędzie)
  clip: boolean; //     zaokrąglone przycinanie tła obudowy (overflow:hidden device)
};

export const DIAG_ALL: Diag = {
  gestures: true, grid: true, filter: true, images: true, matrix: true,
  glow: true, sheen: true, shadow: true, texture: true, bevels: true, clip: true,
};
