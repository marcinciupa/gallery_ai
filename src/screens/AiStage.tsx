/**
 * AiStage — TEXT TO IMAGE (edycja/inpainting AI). Obraz + maska malowana PALCEM (MaskCanvas: rozmiar/tryb
 * pędzla, jak w Magic Erase) + pole promptu „Start typing..." + natywna klawiatura. Prompt można zawęzić do
 * zamalowanego obszaru (inpainting); bez maski = edycja całego obrazu.
 *
 * Prezentacyjno-interaktywny: stan promptu (typing/draft/processing) trzyma edytor; maskę i pędzel — MaskCanvas.
 * Handle (nav/undo/reset) obsługuje joystick edytora. Rasteryzacja maski do PNG dla backendu = TODO.
 */
import { forwardRef, RefObject, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, Pressable, TextInput, ImageSourcePropType } from 'react-native';
import { color, font, screen, textShadow } from '../theme/tokens';
import { MaskCanvas, MaskCanvasHandle } from './MaskCanvas';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;
const PILL = { boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as const;

const BRUSH_TABS = ['MODE', 'BRUSH SIZE'] as const;

/** Pasek zakładek pędzla (MODE / BRUSH SIZE) — fosforowe tło, zaznaczona = ciemna pigułka. */
function BrushTabs({ index, focused, onPick }: { index: number; focused: boolean; onPick: (i: number) => void }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 2, backgroundColor: screen.olive.primary, ...(PILL as any) }}>
      {BRUSH_TABS.map((label, i) =>
        i === index ? (
          <Pressable key={label} onPress={() => onPick(i)} hitSlop={{ top: 16, bottom: 16, left: 6, right: 6 }} style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 3, paddingHorizontal: 3, borderRadius: 2, backgroundColor: color.dark21 }}>
            <Text style={{ ...txt, color: screen.olive.primary, ...phosphorGlow }}>{'•'}</Text>
            <Text style={{ ...txt, color: screen.olive.primary, ...phosphorGlow }}>{label}</Text>
          </Pressable>
        ) : (
          <Pressable key={label} onPress={() => onPick(i)} hitSlop={{ top: 16, bottom: 16, left: 6, right: 6 }} style={{ paddingVertical: 3 }}>
            <Text style={{ ...txt, color: color.dark21 }}>{label}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

export type AiStageHandle = {
  navLeft: () => void; navRight: () => void; navUp: () => void; navDown: () => void; press: () => void;
  undo: () => void;
  reset: () => void;
};

export const AiStage = forwardRef<AiStageHandle, {
  source: ImageSourcePropType;
  draft: string;
  typing: boolean;
  processing: boolean;
  error?: string | null;
  inputRef: RefObject<TextInput | null>;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
  onBlur: () => void;
  onOpenKeyboard: () => void;
  onState?: (s: { hasStrokes: boolean }) => void; // maska istnieje → edytor wie, że to inpainting
}>(function AiStage({ source, draft, typing, processing, error, inputRef, onChangeText, onSubmit, onBlur, onOpenKeyboard, onState }, ref) {
  const maskRef = useRef<MaskCanvasHandle>(null);
  const [first, setFirst] = useState(0);          // MODE / BRUSH SIZE
  const [level, setLevel] = useState<'first' | 'second'>('first');
  const [masking, setMasking] = useState(false);  // czy zaczęto malować maskę (→ welon)
  const firstRef = useRef(first); firstRef.current = first;
  const levelRef = useRef(level); levelRef.current = level;

  useImperativeHandle(ref, () => ({
    navLeft: () => { if (levelRef.current === 'second') maskRef.current?.navValue(-1); else setFirst((i) => Math.max(0, i - 1)); },
    navRight: () => { if (levelRef.current === 'second') maskRef.current?.navValue(1); else setFirst((i) => Math.min(BRUSH_TABS.length - 1, i + 1)); },
    navUp: () => setLevel('second'),
    navDown: () => setLevel('first'),
    press: () => { if (levelRef.current === 'first') setLevel('second'); },
    undo: () => maskRef.current?.undo(),
    reset: () => { maskRef.current?.reset(); setMasking(false); },
  }), []);

  const inputText = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: color.dark21, padding: 0 } as const;
  const panel = typing ? null : first === 0 ? 'mode' : 'size';

  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 8 }}>
      {/* obraz + maska (rozmiar/tryb pędzla). Podczas pisania: pędzel wyłączony, pasek zakładek ukryty. */}
      <MaskCanvas
        ref={maskRef}
        source={source}
        dimmed={masking}
        paintEnabled={!typing && !processing}
        panel={panel}
        secondFocused={level === 'second'}
        onState={onState}
        onPaintStart={() => setMasking(true)}
        onInteractPanel={() => setLevel('second')}
      />
      {!typing ? <BrushTabs index={first} focused={level === 'first'} onPick={(i) => { setFirst(i); setLevel('second'); }} /> : null}

      {/* komunikat błędu */}
      {error ? (
        <Text style={{ fontFamily: font.caption.family, fontSize: font.caption.size, color: color.recordRed, textAlign: 'center' }}>{error}</Text>
      ) : null}

      {/* pole promptu — jasna pigułka fosforowa; tap otwiera klawiaturę, w trybie pisania = TextInput */}
      <View style={{ alignSelf: 'stretch', backgroundColor: screen.olive.primary, borderRadius: 2, padding: 6, ...(PILL as any) }}>
        {typing ? (
          <TextInput
            ref={inputRef}
            autoFocus
            value={draft}
            onChangeText={onChangeText}
            onSubmitEditing={onSubmit}
            onBlur={onBlur}
            blurOnSubmit={false}
            editable={!processing}
            placeholder="Start typing..."
            placeholderTextColor={color.dark21}
            returnKeyType="send"
            style={inputText}
          />
        ) : (
          <Pressable onPress={onOpenKeyboard} disabled={processing}>
            <Text style={{ ...inputText, opacity: draft ? 1 : 0.6 }} numberOfLines={1}>
              {draft || 'Start typing...'}
            </Text>
          </Pressable>
        )}
      </View>

      {/* nakładka przetwarzania */}
      {processing ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(26,26,26,0.55)' }}>
          <Text style={{ fontFamily: font.monoLabel.family, fontSize: 14, letterSpacing: 2, color: screen.olive.primary, ...phosphorGlow }}>PROCESSING…</Text>
        </View>
      ) : null}
    </View>
  );
});
