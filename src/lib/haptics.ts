/**
 * haptics — wibracje klawiszy fizycznych (cel: Android v1; web-podgląd na desktopie ich nie odda).
 *
 * WAŻNE: ani expo-haptics, ani RN `Vibration`, ani web `navigator.vibrate()` NIE sterują
 * amplitudą — znają tylko włącz/wyłącz (czasy w ms). „Moc" symulujemy przez PWM
 * (modulację szerokości impulsu): wyższy duty cycle w okresie nośnej = mocniej odczuwalne.
 * Prawdziwa amplituda wymagałaby natywnego VibrationEffect.createWaveform (do zrobienia później).
 *
 * Wzorzec patternu: [on, off, on, off, …]. Web: navigator.vibrate(pattern) (pierwszy = on).
 * Android (RN): Vibration.vibrate([0, …pattern]) — pierwszy element to wait, więc prependujemy 0.
 */
import { Platform, Vibration } from 'react-native';

const PERIOD = 16; // okres nośnej PWM (ms)

type Seg = { ms: number; from: number; to?: number }; // intensywność 0..1 (ramp from→to)

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Zamienia obwiednię (segmenty intensywności w czasie) na pattern PWM [on,off,…]. */
function pwm(segs: Seg[]): number[] {
  const out: number[] = [];
  for (const s of segs) {
    const n = Math.max(1, Math.round(s.ms / PERIOD));
    const to = s.to ?? s.from;
    for (let i = 0; i < n; i++) {
      const t = clamp01(n === 1 ? s.from : s.from + (to - s.from) * (i / (n - 1)));
      const on = Math.round(PERIOD * t);
      out.push(on, PERIOD - on);
    }
  }
  return out;
}

function play(pattern: number[]) {
  if (!pattern.length) return;
  if (Platform.OS === 'web') {
    const n: any = typeof navigator !== 'undefined' ? navigator : null;
    n?.vibrate?.(pattern);
  } else {
    Vibration.vibrate([0, ...pattern], false);
  }
}

/** Przerwij trwającą wibrację (np. puszczenie [HOLD] przed końcem). */
export function hapticCancel() {
  if (Platform.OS === 'web') {
    const n: any = typeof navigator !== 'undefined' ? navigator : null;
    n?.vibrate?.(0);
  } else {
    Vibration.cancel();
  }
}

/** Wejście aktywnego klawisza: krótki, ale „mocniejszy" (dłuższy) niż na nieaktywnym. */
export function hapticPress() {
  play([110]);
}

/** Zwolnienie aktywnego: krótkie — takie samo jak na nieaktywnych. */
export function hapticRelease() {
  play([45]);
}

/** Puste/nieaktywne przyciski: jedna krótka wibracja (wejście i wyjście). */
export function hapticShort() {
  play([45]);
}

/** Start nagrywania: jeden DŁUŻSZY buzz (wyraźne „zaczęło się"). */
export function hapticRecordStart() {
  play([350]);
}

/** Koniec nagrywania: PODWÓJNY buzz („buzz-buzz") — odróżnialny od startu. */
export function hapticRecordStop() {
  play([200, 110, 200]);
}

/** Knob: krótki impuls o sile proporcjonalnej do wychylenia (wywoływany throttlowany w trakcie ruchu).
 *  `ms` = długość impulsu (domyślnie 28); mniejsze = krótsze „kliknięcie" (np. nawigacja po siatce). */
export function hapticKnob(intensity: number, ms = 28) {
  play(pwm([{ ms, from: intensity }]));
}

/** Bardzo krótki „tick" — pojedynczy stopień na pokrętle prostowania. */
export function hapticTick() {
  play([9]);
}

/** Nieco dłuższy „detent" — próg co 15° na pokrętle (wskoczenie). */
export function hapticDetent() {
  play([32]);
}

/**
 * Knob — powrót do stanu 0 (zawsze, też dla nieaktywnego knoba).
 *  - nieaktywny → POJEDYNCZY krótki tick (1:1 z klawiaturą, hapticShort/Release = 45 ms),
 *  - aktywny → PODWÓJNY tick („tik-tik") — wyraźnie inny od klawiatury i nieaktywnego knoba.
 * (Brak kontroli amplitudy na Androidzie → rozróżniamy LICZBĄ impulsów, nie siłą.)
 */
export function hapticKnobReturn(active: boolean) {
  play(active ? [28, 50, 28] : [45]);
}

/**
 * Ciągła wibracja — seeker: granica nagrania (początek/koniec) oraz scrub przy zatrzymanym/zpauzowanym
 * odtwarzaniu. Trwa do `hapticContinuous(false)` (puszczenie seekera). Amplitudy nie kontrolujemy.
 */
export function hapticContinuous(on: boolean) {
  if (!on) {
    hapticCancel();
    return;
  }
  if (Platform.OS === 'web') {
    const n: any = typeof navigator !== 'undefined' ? navigator : null;
    n?.vibrate?.(60000); // długi buzz; przerywany przez hapticCancel na puszczenie
  } else {
    Vibration.vibrate([0, 1000], true); // powtarzany wzorzec bez przerw = ciągła wibracja do Vibration.cancel()
  }
}

/** [HOLD]: bardzo krótkie impulsy, moc stopniowo rośnie 0→50% do końca przytrzymania. */
export function hapticHold(durationMs: number) {
  const interval = 70; // bardzo krótkie odstępy między impulsami
  const n = Math.max(1, Math.floor(durationMs / interval));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const intensity = 0.5 * ((i + 1) / n); // narasta do 50%
    const on = Math.max(1, Math.round(18 * intensity)); // krótki impuls, coraz mocniejszy
    out.push(on, interval - on);
  }
  play(out);
}
