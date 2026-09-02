/**
 * VideoBadge — oznaczenie kafelka wideo: trójkąt „play" + długość (lewy-DOLNY róg).
 *
 * Dlaczego lewy-dolny: prawy-górny zajmują badge AI/RAW, lewy-górny checkbox zaznaczania, a prawy-dolny
 * uchwyt zmiany rozmiaru kafla w feedzie. To jedyny róg wolny we wszystkich siatkach naraz.
 *
 * Miniaturę samego wideo rysuje zwykły `expo-image` — Glide na Androidzie potrafi wyciągnąć klatkę
 * z `content://` wideo, więc kafle nie potrzebują osobnej ścieżki.
 */
import { View, Text } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import { color, font, screen } from '../theme/tokens';
import { formatDuration } from '../lib/duration';

export function VideoBadge({ source, chrome = screen.olive.primary }: { source?: any; chrome?: string }) {
  if (!source?.video) return null;
  const len = formatDuration(source.duration);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 6, bottom: 5, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Svg width={9} height={10}>
        <Polygon points="0,0 9,5 0,10" fill={chrome} />
      </Svg>
      {len ? <Text style={{ ...badgeTxt, color: chrome }}>{len}</Text> : null}
    </View>
  );
}

const badgeTxt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, textShadowColor: color.dark21, textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } } as const;
