/**
 * Joystick — NOWY element galerii (Figma node 350:4682), środek klawiatury. Zastępuje shuttle/slider
 * z rec_ai jako główna kontrolka nawigacji. Fizycznie: metalowy kwadrat 64 (wypukły bevel) → wklęsła
 * ciemna studnia 56 → wypukły metalowy grzybek 24 (przesuwa się za palcem, sprężynuje na środek).
 *
 * Sterowanie 4-kierunkowe (discrete, jak knob dyskretny w Settings): po przekroczeniu progu wychylenia
 * odpala JEDEN raz onUp/onDown/onLeft/onRight (dominująca oś), środek (tap bez wychylenia) = onPress.
 * Haptyka z Warstwy 0 (§9): hapticKnob na tick kierunku, hapticKnobReturn na powrót, hapticPress/Release
 * na środek.
 */
import { useEffect, useRef } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import { dims, gradient } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { Bevel } from './primitives';
import { shadow, elevationShadow } from '../../theme/tokens';
import { hapticKnob, hapticKnobReturn, hapticPress, hapticRelease, hapticShort } from '../../lib/haptics';

/** Konfiguracja joysticka dla danego ekranu (kontekstowa jak KeyboardConfig/SliderConfig). */
export type JoystickConfig = {
  highlighted?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onPress?: () => void; // wciśnięcie środka
  repeat?: boolean;     // przytrzymanie wychylenia → powtarzaj kierunek do puszczenia (auto-repeat)
  // CIĄGŁE WYCHYLENIE: onDirStart w chwili wychylenia, onDirEnd przy puszczeniu/przerwaniu. Pozwala
  // konsumentowi zrobić PŁYNNY ruch zamiast serii kroków (feed przewija się tak zamiast skakać po wierszach).
  // Niezależne od `repeat` — można używać obu albo tylko tych.
  onDirStart?: (dir: 'up' | 'down' | 'left' | 'right') => void;
  onDirEnd?: () => void;
  shortStepHaptic?: boolean; // krótszy impuls na krok (np. szybka nawigacja po siatce gallery/feed)
  // PRZYTRZYMANIE ŚRODKA (bez wychylenia): onHoldStart po krótkim czasie (feedback — np. chowaj kursor),
  // onHoldComplete po `holdMs` (akcja — np. wejście w tryb zaznaczania), onHoldCancel przy puszczeniu przed
  // czasem lub wychyleniu. Krótki tap (< próg startu) nie odpala żadnego z nich → nadal działa onPress.
  onHoldStart?: () => void;
  onHoldComplete?: () => void;
  onHoldCancel?: () => void;
  holdMs?: number; // domyślnie 550
};

type Dir = 'up' | 'down' | 'left' | 'right';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function Joystick({ config }: { config?: JoystickConfig }) {
  const t = useTheme();
  const cfgRef = useRef(config);
  cfgRef.current = config;

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const fired = useRef(false);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // przytrzymanie środka (hold-to-select): dwa timery — startowy (feedback) i pełny (akcja)
  const holdStartT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdCompleteT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStarted = useRef(false);
  const holdCompleted = useRef(false);
  const clearHold = () => {
    if (holdStartT.current) { clearTimeout(holdStartT.current); holdStartT.current = null; }
    if (holdCompleteT.current) { clearTimeout(holdCompleteT.current); holdCompleteT.current = null; }
  };

  const callDir = (dir: Dir) => {
    const c = cfgRef.current;
    (dir === 'right' ? c?.onRight : dir === 'left' ? c?.onLeft : dir === 'down' ? c?.onDown : c?.onUp)?.();
  };
  const stopRepeat = () => { if (repeatTimer.current) { clearInterval(repeatTimer.current); repeatTimer.current = null; } };
  const stepMs = () => (cfgRef.current?.shortStepHaptic ? 14 : 28); // krótszy „klik" przy szybkiej nawigacji

  // OPÓR PROGRESYWNY: im dalej wychylisz gałkę, tym mocniejszy impuls — imitacja rosnącego oporu
  // sprężyny w fizycznym joysticku. Droga gałki dzielona na DETENTS zapadek; impuls leci przy KAŻDYM
  // przekroczeniu zapadki W STRONĘ WYCHYLENIA (przy powrocie do środka nie — opór maleje, nie rośnie).
  // Bez kwantyzacji na zapadki trzeba by strzelać haptyką na każde zdarzenie ruchu (~60/s) = brzęczenie.
  const DETENTS = 6;
  const lastDetent = useRef(0);
  const curDir = useRef<Dir | null>(null); // kierunek trzymany TERAZ (do zmiany w locie)
  const detentAt = (dist: number, max: number) => Math.min(DETENTS, Math.round((Math.min(dist, max) / max) * DETENTS));
  // przytrzymanie wychylenia (repeat) → powtarzaj kierunek co 120 ms aż do puszczenia
  const startRepeat = (dir: Dir) => {
    if (!cfgRef.current?.repeat) return;
    stopRepeat();
    // Nawigacja powtarza się co 120 ms, ale HAPTYKA co drugi tick (~240 ms): przy pełnym wychyleniu
    // 120 ms czytało się jako zbyt gęste brzęczenie. Częstotliwość odczepiona od tempa nawigacji, żeby
    // zmiana odczucia nie spowalniała przewijania siatki.
    let tick = 0;
    repeatTimer.current = setInterval(() => { callDir(dir); if (tick++ % 2 === 0) hapticKnob(0.3, stepMs()); }, 120);
  };
  useEffect(() => () => { stopRepeat(); clearHold(); }, []);

  const springBack = () => {
    Animated.spring(tx, { toValue: 0, useNativeDriver: false }).start();
    Animated.spring(ty, { toValue: 0, useNativeDriver: false }).start();
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.hypot(g.dx, g.dy) > 3,
      // nie oddawaj gestu innym responderom (np. ekranowemu swipe) — inaczej poziome ruchy joysticka giną
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        lastDetent.current = 0;
        curDir.current = null;
        fired.current = false;
        holdStarted.current = false;
        holdCompleted.current = false;
        const c = cfgRef.current;
        const hasAny = !!(c && (c.onUp || c.onDown || c.onLeft || c.onRight || c.onPress));
        hasAny ? hapticPress() : hapticShort();
        // uzbrój timery przytrzymania (tylko gdy ekran ich używa). Start = 260 ms (feedback), pełny = holdMs (akcja).
        if (c?.onHoldComplete || c?.onHoldStart) {
          const full = c.holdMs ?? 550;
          holdStartT.current = setTimeout(() => { holdStarted.current = true; cfgRef.current?.onHoldStart?.(); }, Math.min(260, full * 0.5));
          holdCompleteT.current = setTimeout(() => { holdCompleted.current = true; hapticKnob(0.8, 40); cfgRef.current?.onHoldComplete?.(); }, full);
        }
      },
      onPanResponderMove: (_e, g) => {
        const max = dims.joystick.nubTravel;
        tx.setValue(clamp(g.dx, -max, max));
        ty.setValue(clamp(g.dy, -max, max));
        const det = detentAt(Math.hypot(g.dx, g.dy), max);
        if (det > lastDetent.current) hapticKnob(0.12 + 0.62 * (det / DETENTS), 12); // opór rośnie z wychyleniem
        // powrót gałki do neutrum (jeszcze w trakcie gestu) → delikatne „klik" zerowe. Puszczenie gałki
        // ma osobny sygnał (hapticKnobReturn w release), więc tego nie dublujemy.
        else if (det === 0 && lastDetent.current > 0) hapticKnob(0.1, 10);
        lastDetent.current = det;
        const th = dims.joystick.dirThreshold;
        const ax = Math.abs(g.dx), ay = Math.abs(g.dy);
        // odpal, gdy dominująca oś przekroczy próg i WYRAŹNIE przeważa (≥1.3×) — inaczej skośny swipe
        // odpala w bok zamiast w dół/górę (rzadkie „poszło nie tam"); przy jasnej dominacji reaguje od razu.
        const dom = Math.max(ax, ay), sub = Math.min(ax, ay);
        if (!(dom > th && dom >= sub * 1.3)) return;
        // dominująca oś decyduje o kierunku (4-kier., bez skosów)
        const dir: Dir = ax >= ay ? (g.dx > 0 ? 'right' : 'left') : (g.dy > 0 ? 'down' : 'up');
        if (dir === curDir.current) return; // ten sam kierunek → nic nowego
        // ZMIANA KIERUNKU W LOCIE: wcześniej `fired.current` blokował ponowną ocenę na resztę gestu, więc
        // raz złapany kierunek trzymał się do puszczenia gałki. Teraz przestawienie gałki (np. z góry na dół)
        // przełącza nawigację bez odrywania palca. Haptyka „dzieje się sama": przechodząc przez środek
        // gałka schodzi przez zapadki do zera (impuls neutrum) i znów narasta po drugiej stronie.
        const first = !fired.current;
        fired.current = true;
        curDir.current = dir;
        if (first) {
          // wychylenie = nawigacja, nie przytrzymanie środka → anuluj hold i przywróć kursor, jeśli już schowany
          if (holdStarted.current && !holdCompleted.current) cfgRef.current?.onHoldCancel?.();
          clearHold();
        }
        stopRepeat(); // przy zmianie kierunku stary auto-repeat musi zgasnąć, inaczej lecą oba naraz
        // onDirStart wołamy TAKŻE przy zmianie (bez onDirEnd) — konsument ma wtedy tylko zmienić kierunek
        // ruchu, a nie zatrzymywać się i wybierać kafla.
        cfgRef.current?.onDirStart?.(dir);
        callDir(dir);
        startRepeat(dir); // przy repeat: trzymanie wychylenia powtarza kierunek
        lastDetent.current = DETENTS; // nie dubluj zapadki z impulsem zlapania kierunku
        hapticKnob(0.5, stepMs()); // krótki impuls na zmianie (jak knob discrete)
      },
      onPanResponderRelease: (_e, g) => {
        clearHold();
        stopRepeat();
        if (fired.current) cfgRef.current?.onDirEnd?.();
        springBack();
        const moved = Math.hypot(g.dx, g.dy);
        const c = cfgRef.current;
        if (holdCompleted.current) {
          // przytrzymanie dobiegło końca (akcja już odpalona w timerze) → NIE traktuj jako tap
          hapticKnobReturn(!!c?.highlighted);
        } else {
          if (holdStarted.current) c?.onHoldCancel?.(); // puszczono przed czasem → przywróć kursor
          if (!fired.current && moved < 6) {
            // brak wychylenia → wciśnięcie środka
            c?.onPress?.();
            hapticRelease();
          } else {
            hapticKnobReturn(!!c?.highlighted);
          }
        }
        curDir.current = null;
        fired.current = false;
        holdStarted.current = false;
        holdCompleted.current = false;
      },
      onPanResponderTerminate: () => {
        clearHold();
        stopRepeat();
        springBack();
        if (fired.current) cfgRef.current?.onDirEnd?.(); // inaczej ciągły ruch zostałby włączony na zawsze
        if (holdStarted.current && !holdCompleted.current) cfgRef.current?.onHoldCancel?.();
        fired.current = false;
        holdStarted.current = false;
        holdCompleted.current = false;
        lastDetent.current = 0;
        curDir.current = null;
      },
    })
  ).current;

  const hl = config?.highlighted;
  const rec = t.recessedBevel;
  return (
    // outer: metalowy kwadrat 64 (wypukły bevel)
    <Bevel
      stroke={t.raisedBevel}
      width={1}
      radius={dims.key.radius}
      fill={t.metal}
      style={{ width: dims.joystick.size, height: dims.joystick.size }}
      innerStyle={{ alignItems: 'center', justifyContent: 'center' }}
    >
      <View {...pan.panHandlers} style={{ padding: dims.joystick.wellOffset }}>
        {/* studnia: wklęsła ciemna kołowa wnęka (recessed bevel + inset shadow). Plain View (bez overflow
            hidden Bevela), żeby wypukły cień grzybka się nie obciął. */}
        <View
          style={
            {
              width: dims.joystick.well,
              height: dims.joystick.well,
              borderRadius: dims.joystick.wellRadius,
              backgroundColor: '#1A1A1A',
              borderTopWidth: 1,
              borderLeftWidth: 1,
              borderBottomWidth: 1,
              borderRightWidth: 1,
              borderTopColor: rec.colors[0], // recessed: cień góra+lewo
              borderLeftColor: rec.colors[0],
              borderBottomColor: rec.colors[1], // światło dół+prawo
              borderRightColor: rec.colors[1],
              boxShadow: shadow.keyInsetReduction,
              alignItems: 'center',
              justifyContent: 'center',
            } as any
          }
        >
          {/* grzybek: wypukły metalowy dysk 24, przesuwa się za palcem */}
          <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }] }}>
            <Bevel
              stroke={t.raisedBevel}
              width={1}
              radius={dims.joystick.nub / 2}
              fillGradient={hl ? gradient.bevelButton : gradient.bevelSharp}
              style={{ width: dims.joystick.nub, height: dims.joystick.nub, boxShadow: elevationShadow(t) }}
            />
          </Animated.View>
        </View>
      </View>
    </Bevel>
  );
}
