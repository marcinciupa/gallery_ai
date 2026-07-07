/**
 * Wspólne chrome ekranu (w szybie): pasek u góry z deAPI + przełącznikiem trybu (pigułka
 * „zakamuflowana" jako label — tap cykluje tryb). Tryby galerii: BROWSE / VIEWER / SETTINGS.
 * (rozjazd vs rec_ai RECORDING/PLAYBACK/SETTINGS + brak dolnego miernika stereo — galeria go nie ma.)
 */
import { useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated } from 'react-native';
import { hapticPress, hapticRelease, hapticShort } from '../lib/haptics';
import { color, font, screen, textShadow } from '../theme/tokens';
import { DeApiIcon } from '../components/icons';

export type Mode = 'GALLERY' | 'VIEWER' | 'SETTINGS';

/** Tryb wyświetlania treści (§11b.1) — ile skeuomorfizmu na zdjęciu:
 *  IMMERSIVE = B&W + fosfor + matryca; RETRO = kolor + matryca + lekki fosfor; CLEAN = czyste zdjęcia. */
export type DisplayMode = 'IMMERSIVE' | 'RETRO' | 'CLEAN';

const NEXT: Record<Mode, Mode> = {
  GALLERY: 'VIEWER',
  VIEWER: 'SETTINGS',
  SETTINGS: 'GALLERY',
};
export const nextMode = (m: Mode): Mode => NEXT[m];

/** Status AI w pasku (deAPI). `lines: null` = przygaszony (idle); `pulse` = ikona pulsuje. */
export type AiStatusView = { lines: string[] | null; pulse?: boolean };

/**
 * Lewy klawisz metalowy = FIZYCZNY klawisz `STOP/BACK` — label STAŁY, zmienia się PODŚWIETLENIE.
 * (na razie nieużywany w tym układzie klawiatury — zachowany do przyszłych ekranów galerii.)
 */
export function stopBackKey(opts: { canStop?: boolean; onStop?: () => void; onBack?: () => void }) {
  const canStop = !!opts.canStop;
  const backLit = !canStop && !!opts.onBack;
  return {
    type: 'label' as const,
    upper: 'STOP',
    lower: 'BACK',
    active: canStop,
    lowerActive: backLit,
    onPress: canStop ? opts.onStop : opts.onBack,
  };
}

/** Pigułka trybu. `active` = pełne tło + glow; inaczej wygaszone (25% tła, bez glow). */
function ScreenLabel({ mode, label, onPress, active = true }: { mode: Mode; label?: string; onPress?: () => void; active?: boolean }) {
  const bg = active ? screen.olive.primary : screen.olive.inactive;
  const boxShadow = active ? '0px 0px 4px 0px rgba(226,255,228,0.25)' : undefined;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPress ? hapticPress : hapticShort}
      onPressOut={onPress ? hapticRelease : hapticShort}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 2,
        backgroundColor: bg,
        ...(boxShadow ? { boxShadow } : null),
      }}
    >
      <Text style={{ fontFamily: font.bodyLgBold.family, fontSize: font.bodyLgBold.size, color: color.dark21 }}>
        {label ?? mode}
      </Text>
    </Pressable>
  );
}

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: 4,
  textShadowOffset: { width: 0, height: 0 },
} as const;

/** Znaczek deAPI: przygaszony (idle, lines=null) lub aktywny z 2-liniowym tekstem. Kolor ZAWSZE phosphor. */
function DeApiLabel({ ai }: { ai?: AiStatusView }) {
  const pulse = !!ai?.pulse;
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) {
      op.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0.6, duration: 700, useNativeDriver: false }),
        Animated.timing(op, { toValue: 1, duration: 700, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, op]);

  if (!ai || ai.lines === null) {
    return (
      <View style={{ opacity: 0.25 }}>
        <DeApiIcon size={24} />
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Animated.View style={{ opacity: pulse ? op : 1 }}>
        <DeApiIcon size={24} />
      </Animated.View>
      <View>
        {ai.lines.map((line, i) => (
          <Text
            key={i}
            style={{ fontFamily: font.caption.family, fontSize: font.caption.size, color: screen.olive.primary, ...phosphorGlow }}
          >
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Pasek statusu w szybie: deAPI z lewej, przełącznik trybu z prawej. */
export function ScreenTopBar({
  mode,
  label,
  onCycleMode,
  ai,
  labelActive = true,
}: {
  mode: Mode;
  label?: string;
  onCycleMode?: () => void;
  ai?: AiStatusView;
  labelActive?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', alignSelf: 'stretch' }}>
      <DeApiLabel ai={ai} />
      <ScreenLabel mode={mode} label={label} onPress={onCycleMode} active={labelActive} />
    </View>
  );
}
