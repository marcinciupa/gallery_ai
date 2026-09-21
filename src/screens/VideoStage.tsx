/**
 * VideoStage — odtwarzanie wideo w podglądzie (ta sama „szyba" co ZoomImage, tylko zamiast obrazu film).
 *
 * ZAKRES (świadomie prosty): odtwarzanie / pauza, pasek postępu z przewijaniem przez dotknięcie, czas
 * miniony i pozostały. Bez zoomu, bez edycji — wideo w tej apce jest do OBEJRZENIA, a narzędzia AI
 * i kadrowanie działają na zdjęciach (patrz `useImageEditor`, gałąź `isVideo`).
 *
 * ⚠️ `player.currentTime` odpytujemy interwałem, a nie zdarzeniem `timeUpdate`: zdarzenie leci kilka razy
 * na sekundę i przy każdym wywołaniu przerysowywałoby cały podgląd. 250 ms wystarcza paskowi postępu,
 * a interwał chodzi TYLKO gdy film gra.
 *
 * Sterowanie klawiszami/joystickiem siedzi w `useImageEditor` — tu wystawiamy imperatywne `toggle()`.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, LayoutChangeEvent, ImageSourcePropType } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Polygon } from 'react-native-svg';
import { color, font, screen } from '../theme/tokens';
import { formatDuration } from '../lib/duration';

export type VideoStageHandle = {
  /** PLAY/PAUSE z klawisza i z press joysticka. */
  toggle: () => void;
  /** Czy gra (do etykiety klawisza). */
  playing: boolean;
};

const SWIPE = 60; // próg swipe'a prev/next — jak w ZoomImage

export const VideoStage = forwardRef<VideoStageHandle, {
  source: ImageSourcePropType;
  onPrev?: () => void;
  onNext?: () => void;
  onPlayingChange?: (playing: boolean) => void;
}>(function VideoStage({ source, onPrev, onNext, onPlayingChange }, ref) {
  const uri = String((source as any)?.uri ?? '');
  // `duration` z MediaStore (ms) jest znane OD RAZU — pasek ma sensowną skalę, zanim player się przygotuje.
  const metaMs = (source as any)?.duration as number | null | undefined;

  const player = useVideoPlayer(uri, (p) => { p.loop = false; p.muted = false; });
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [totalMs, setTotalMs] = useState(metaMs ?? 0);

  // Stan odtwarzania i pozycję ODPYTUJEMY, nie nasłuchujemy.
  //
  // ⚠️ ZNALEZIONE NA EMULATORZE (v0.968): `player.addListener('playingChange', …)` nie dociera do JS —
  // film startował (ExoPlayer w logcacie tworzył dekoder), ale klawisz dalej pokazywał PLAY, duży trójkąt
  // nie znikał, a pasek stał na 0:00. Objaw mylący, bo wygląda jak „nie odtwarza", a dźwięk i obraz idą.
  // Właściwości `player.playing` / `currentTime` / `duration` są wiarygodne, więc czytamy je interwałem.
  // 250 ms wystarcza paskowi, a timer żyje tylko póki otwarty jest film.
  useEffect(() => {
    const read = () => {
      try {
        const p = player.playing;
        setPlaying((prev) => { if (prev !== p) onPlayingChange?.(p); return p; });
        setPosMs(Math.max(0, Math.round(player.currentTime * 1000)));
        const d = player.duration;
        if (Number.isFinite(d) && d > 0) setTotalMs(Math.round(d * 1000));
      } catch { /* player mógł już zniknąć */ }
    };
    read();
    const id = setInterval(read, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  // zmiana pliku (PREV/NEXT) → od zera i bez grania
  useEffect(() => { setPosMs(0); setPlaying(false); setTotalMs(metaMs ?? 0); }, [uri, metaMs]);

  const toggle = () => {
    try {
      if (player.playing) player.pause();
      else {
        // dobiegł do końca → PLAY zaczyna od początku (inaczej nic by się nie stało)
        if (totalMs > 0 && posMs >= totalMs - 400) player.currentTime = 0;
        player.play();
      }
    } catch { /* nie udało się — trudno, klawisz zostaje */ }
  };
  useImperativeHandle(ref, () => ({ toggle, playing }), [playing, totalMs, posMs]);

  // swipe poziomy = PREV/NEXT (pionowego nie ma: to gest systemowego przewijania i tu nie ma czego chować)
  const startX = useRef(0);
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: (_e, g) => { startX.current = g.dx; },
      onPanResponderRelease: (_e, g) => {
        const dx = g.dx - startX.current;
        if (dx <= -SWIPE) onNext?.();
        else if (dx >= SWIPE) onPrev?.();
      },
    })
  ).current;

  const [barW, setBarW] = useState(0);
  const seekTo = (x: number) => {
    if (!barW || !totalMs) return;
    const f = Math.max(0, Math.min(1, x / barW));
    try { player.currentTime = (totalMs * f) / 1000; setPosMs(Math.round(totalMs * f)); } catch {}
  };

  const left = formatDuration(Math.max(0, totalMs - posMs)) ?? '0:00';
  const done = formatDuration(posMs) ?? '0:00';
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, posMs / totalMs)) : 0;

  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 10 }}>
      <View style={{ flex: 1, alignSelf: 'stretch', borderRadius: 2, overflow: 'hidden' }} {...responder.panHandlers}>
        <Pressable onPress={toggle} style={{ flex: 1 }}>
          <VideoView
            player={player}
            nativeControls={false}
            contentFit="contain"
            style={{ flex: 1, backgroundColor: color.dark1A }}
          />
          {/* duży trójkąt play na środku, gdy film stoi — jedyny sygnał, że to nie zdjęcie */}
          {!playing ? (
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
              <Svg width={54} height={60}>
                <Polygon points="0,0 54,30 0,60" fill={screen.olive.primary} opacity={0.85} />
              </Svg>
            </View>
          ) : null}
        </Pressable>
      </View>
      {/* pasek postępu: dotknięcie = przewinięcie; po bokach czas miniony i POZOSTAŁY (jak w dyktafonie) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={timeTxt}>{done}</Text>
        <Pressable
          onPress={(e) => seekTo(e.nativeEvent.locationX)}
          onLayout={(e: LayoutChangeEvent) => setBarW(e.nativeEvent.layout.width)}
          hitSlop={10}
          style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: color.dark21 }}
        >
          <View style={{ width: `${frac * 100}%`, height: '100%', borderRadius: 2, backgroundColor: screen.olive.primary }} />
        </Pressable>
        <Text style={timeTxt}>-{left}</Text>
      </View>
    </View>
  );
});

const timeTxt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: screen.olive.primary, minWidth: 46 } as const;
