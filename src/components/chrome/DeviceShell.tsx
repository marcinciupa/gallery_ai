/**
 * DeviceShell — obudowa urządzenia (stała rama). Składa elementy w jednym z dwóch wariantów.
 * `children` trafia „w ekran" jako treść aplikacji.
 *
 *  body
 *   ├─ UpperMic            (device: logo+grille+REC | fullscreen: pusty pas)
 *   ├─ interaction_area
 *   │   ├─ Display (slot)  ← treść aplikacji
 *   │   └─ Keyboard        (5 slotów + joystick — bez osobnego rzędu slidera, rozjazd vs rec_ai)
 *   └─ LowerMic
 */
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, View, PanResponder, Platform, Keyboard as RNKeyboard } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { dims, gradient, themes, ThemeName } from '../../theme/tokens';
import { ThemeProvider, useTheme } from '../../theme/ThemeContext';
import { TiltProvider } from '../../theme/TiltContext';
import { BlinkProvider } from '../../theme/BlinkContext';
import { useTilt } from '../../hooks/useTilt';
import { Forehead } from './Forehead';
import { Display } from './Display';
import { Keyboard, KeyboardConfig } from './Keyboard';
import { Diag, DIAG_ALL } from '../../lib/diag';

export type Variant = 'device' | 'fullscreen';

const TEXTURE = require('../../../assets/figma/body_texture.png');

const CASING_BEVEL_LIGHT = gradient.bodyStroke.colors[0];
const CASING_BEVEL_SHADOW = gradient.bodyStroke.colors[1];

function Body({
  variant,
  recording,
  motion,
  keyboard,
  hideControls,
  onPinch,
  onScreenPinch,
  onScreenSwipe,
  diag = DIAG_ALL,
  children,
}: {
  variant: Variant;
  recording?: boolean;
  motion?: boolean;
  keyboard?: KeyboardConfig;
  hideControls?: boolean;
  onPinch?: (dir: 'in' | 'out') => void;
  onScreenPinch?: (dir: 'in' | 'out') => void;
  onScreenSwipe?: (dir: 'left' | 'right') => void;
  diag?: Diag; // DIAG: runtime'owe wyłączanie podsystemów (bisect wydajności)
  children?: ReactNode;
}) {
  const { bodyMetal } = useTheme();
  const { tx, ty } = useTilt(!!motion);
  const tiltValue = useMemo(() => ({ tx, ty }), [tx, ty]);

  // GEST na urządzeniu — JEDEN responder z hit-testem środka gestu (deterministycznie, bez podwójnego
  // odpalenia device/fullscreen + kolumn naraz):
  //  • PINCH 2 palce: środek NAD szybą → liczba kolumn (onScreenPinch); poza szybą → device/fullscreen (onPinch)
  //  • SWIPE 1 palec poziomo NAD szybą → cykl efektu miniatur (onScreenSwipe)
  // Rozsunięcie >1.25 → 'out', zsunięcie <0.8 → 'in'. Zonę liczymy z okna szyby (measureInWindow).
  const onPinchRef = useRef(onPinch);
  onPinchRef.current = onPinch;
  const onScreenPinchRef = useRef(onScreenPinch);
  onScreenPinchRef.current = onScreenPinch;
  const onSwipeRef = useRef(onScreenSwipe);
  onSwipeRef.current = onScreenSwipe;
  const screenRect = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const inScreen = (x: number, y: number) => {
    const r = screenRect.current;
    return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  };
  const touchDist = (t: any[]) => Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
  const gesture = useRef(
    (() => {
      const s = { d: null as number | null, fired: false, swiped: false, onScreen: false };
      return PanResponder.create({
        // BUBBLE (jak rec_ai) — pytany tylko gdy nikt nie trzyma gestu, więc podczas scrolla/joysticka NIE
        // odpala się co klatkę (capture obciążał wątek JS na każdym ruchu = jank). Pinch: 2 palce; swipe:
        // 1 palec poziomo NAD szybą (inScreen — nie kradnie poziomych gestów joysticka na klawiaturze).
        onMoveShouldSetPanResponder: (e, g) => {
          const n = e.nativeEvent.touches.length;
          if (n === 2) return true;
          return n === 1 && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && inScreen(g.moveX, g.moveY);
        },
        onPanResponderGrant: () => { s.d = null; s.fired = false; s.swiped = false; },
        onPanResponderMove: (e, g) => {
          const ts = e.nativeEvent.touches;
          if (ts.length === 2) {
            if (s.d == null) {
              s.d = touchDist(ts);
              s.fired = false;
              s.onScreen = inScreen((ts[0].pageX + ts[1].pageX) / 2, (ts[0].pageY + ts[1].pageY) / 2);
              return;
            }
            if (s.fired) return;
            const ratio = touchDist(ts) / s.d;
            const dir = ratio > 1.25 ? 'out' : ratio < 0.8 ? 'in' : null;
            if (dir) { s.fired = true; (s.onScreen ? onScreenPinchRef.current : onPinchRef.current)?.(dir); }
            return;
          }
          // swipe poziomy (1 palec) — tylko gdy nad szybą
          if (!s.swiped && Math.abs(g.dx) > 40 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && inScreen(e.nativeEvent.pageX, e.nativeEvent.pageY)) {
            s.swiped = true;
            onSwipeRef.current?.(g.dx < 0 ? 'left' : 'right');
          }
        },
        onPanResponderRelease: () => { s.d = null; s.swiped = false; },
        onPanResponderTerminate: () => { s.d = null; s.swiped = false; },
      });
    })()
  ).current;
  // pomiar okna szyby (hit-test gestów natywnie + kursora przy web ctrl+wheel)
  const screenRef = useRef<View>(null);
  const measureScreen = () => {
    (screenRef.current as any)?.measureInWindow?.((x: number, y: number, w: number, h: number) => {
      screenRect.current = { x, y, w, h };
    });
  };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let last = 0;
    const onWheel = (e: any) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      const dir = e.deltaY < 0 ? 'out' : 'in';
      const r = screenRect.current;
      const onScreen = !!r && e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h;
      (onScreen ? onScreenPinchRef.current : onPinchRef.current)?.(dir);
    };
    const onResize = () => measureScreen();
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('resize', onResize); };
  }, []);
  const texShift = tx.interpolate({ inputRange: [-1, 1], outputRange: [-16, 16] });
  const radius =
    variant === 'device'
      ? {
          borderTopLeftRadius: dims.bodyRadius.tl,
          borderTopRightRadius: dims.bodyRadius.tr,
          borderBottomRightRadius: dims.bodyRadius.br,
          borderBottomLeftRadius: dims.bodyRadius.bl,
        }
      : null;
  const [micH, setMicH] = useState(0);
  const [screenH, setScreenH] = useState(0);
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    if (!hideControls) { setKbH(0); return; }
    const show = RNKeyboard.addListener('keyboardDidShow', (e) => setKbH(e.endCoordinates?.height ?? 0));
    const hide = RNKeyboard.addListener('keyboardDidHide', () => setKbH(0));
    return () => { show.remove(); hide.remove(); };
  }, [hideControls]);
  return (
    <BlinkProvider active={!!recording}>
    <TiltProvider value={tiltValue}>
    <View
      {...(diag.gestures ? gesture.panHandlers : {})}
      style={{ flex: 1 }}
    >
      {/* TŁO (metal + tekstura) — TYLKO ta statyczna warstwa jest przycinana do zaokrąglonych rogów
          obudowy (device). Dynamiczna treść (ekran/klawiatura z filtrami) NIE jest przycinana, więc
          GPU nie renderuje całej blendo-ciężkiej obudowy do offscreen (to powodowało jank w device;
          fullscreen bez przycinania = sztywne 60fps). */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, ...radius, ...(diag.clip ? { overflow: 'hidden' } : null) } as any}>
        <LinearGradient
          colors={bodyMetal.colors}
          start={bodyMetal.start}
          end={bodyMetal.end}
          style={{ position: 'absolute', inset: 0 }}
        />
        {/* brushed-metal: mixBlendMode overlay (oryginalny wygląd). Tło metalu jest w nie-scrollowanym
            chrome (w obszarze siatki zasłania je nieprzezroczysta szyba), więc blend nie kosztuje na
            klatkę scrolla — jank pochodził z matrycy, nie stąd. (DIAG: texture) */}
        {diag.texture ? (
          <Animated.View
            style={{ position: 'absolute', top: 0, bottom: 0, left: -24, right: -24, opacity: 0.5, mixBlendMode: 'overlay', transform: [{ translateX: texShift }] } as any}
          >
            <Image source={TEXTURE} resizeMode="cover" style={{ width: '100%', height: '100%' }} />
          </Animated.View>
        ) : null}
      </View>
      {/* czoło (górna sekcja, puste) — mierzymy wysokość dla górnego bevela */}
      <View style={{ alignSelf: 'stretch' }} onLayout={(e) => setMicH(e.nativeEvent.layout.height)}>
        <Forehead variant={variant} />
      </View>
      {/* szyba — flex:1 wypełnia obszar nad dolną sekcją. Responder szyby (pinch→kolumny, swipe→efekt)
          + ref/onLayout do pomiaru okna (hit-test kursora na web) + wysokość dla bevela. */}
      <View
        ref={screenRef}
        style={{ flex: 1, alignSelf: 'stretch' }}
        onLayout={(e) => { setScreenH(e.nativeEvent.layout.height); measureScreen(); }}
      >
        <Display diag={diag}>{children}</Display>
      </View>
      {/* dolna sekcja obudowy (klawiatura z joystickiem) */}
      <View style={[{ alignSelf: 'stretch', alignItems: 'center' }, hideControls && kbH > 0 ? { height: kbH, overflow: 'hidden' } : null]}>
        <Keyboard config={keyboard} />
      </View>
      {/* BEVEL OBUDOWY. micH = pas górny, screenH = szyba. Guard tylko na screenH. (DIAG: bevels) */}
      {diag.bevels && screenH > 0 && (
        <>
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: micH, height: 1, backgroundColor: CASING_BEVEL_SHADOW }} />
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: micH + screenH - 1, height: 1, backgroundColor: CASING_BEVEL_LIGHT }} />
          {variant === 'device' && (
            <>
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: micH,
                  borderTopLeftRadius: dims.bodyRadius.tl,
                  borderTopRightRadius: dims.bodyRadius.tr,
                  borderTopWidth: 1,
                  borderLeftWidth: 1,
                  borderRightWidth: 1,
                  borderTopColor: CASING_BEVEL_LIGHT,
                  borderLeftColor: CASING_BEVEL_LIGHT,
                  borderRightColor: CASING_BEVEL_SHADOW,
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: micH + screenH,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  borderBottomLeftRadius: dims.bodyRadius.bl,
                  borderBottomRightRadius: dims.bodyRadius.br,
                  borderRightWidth: 1,
                  borderBottomWidth: 1,
                  borderRightColor: CASING_BEVEL_SHADOW,
                  borderBottomColor: CASING_BEVEL_SHADOW,
                }}
              />
            </>
          )}
        </>
      )}
    </View>
    </TiltProvider>
    </BlinkProvider>
  );
}

export function DeviceShell({
  variant = 'device',
  recording = false,
  theme = 'LIGHT',
  motion = false,
  keyboard,
  hideControls,
  onPinch,
  onScreenPinch,
  onScreenSwipe,
  diag = DIAG_ALL,
  children,
}: {
  variant?: Variant;
  recording?: boolean;
  theme?: ThemeName;
  motion?: boolean;
  keyboard?: KeyboardConfig;
  hideControls?: boolean;
  onPinch?: (dir: 'in' | 'out') => void;
  onScreenPinch?: (dir: 'in' | 'out') => void;
  onScreenSwipe?: (dir: 'left' | 'right') => void;
  diag?: Diag;
  children?: ReactNode;
}) {
  if (variant === 'fullscreen') {
    return (
      <ThemeProvider value={themes[theme]}>
        <LinearGradient colors={gradient.appBg.colors} start={gradient.appBg.start} end={gradient.appBg.end} style={{ flex: 1 }}>
          <Body
            variant="fullscreen"
            recording={recording}
            motion={motion}
            keyboard={keyboard}
            hideControls={hideControls}
            onPinch={onPinch}
            onScreenPinch={onScreenPinch}
            onScreenSwipe={onScreenSwipe}
            diag={diag}
          >
            {children}
          </Body>
        </LinearGradient>
      </ThemeProvider>
    );
  }
  // device — urządzenie-gadżet z marginesem
  return (
    <ThemeProvider value={themes[theme]}>
      <View style={{ flex: 1, backgroundColor: '#000000' }}>
        <View style={{ flex: 1, padding: 8 }}>
          <Body
            variant="device"
            recording={recording}
            motion={motion}
            keyboard={keyboard}
            hideControls={hideControls}
            onPinch={onPinch}
            onScreenPinch={onScreenPinch}
            onScreenSwipe={onScreenSwipe}
            diag={diag}
          >
            {children}
          </Body>
        </View>
      </View>
    </ThemeProvider>
  );
}
