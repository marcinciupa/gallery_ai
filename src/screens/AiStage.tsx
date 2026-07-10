/**
 * AiStage — ekran edycji AI (Figma 399:4950): obraz + pole promptu „Start typing..." + natywna klawiatura.
 * Prezentacyjny — stan (typing/draft/processing) trzyma edytor; tu tylko render + TextInput (ref z edytora).
 * Pisanie: pole otwiera systemową klawiaturę; App chowa dolną obudowę i wchodzi w fullscreen (hideControls).
 */
import { RefObject } from 'react';
import { View, Text, Pressable, TextInput, ImageSourcePropType, Image as RNImage } from 'react-native';
import { color, font, screen, textShadow } from '../theme/tokens';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

export function AiStage({
  source,
  draft,
  typing,
  processing,
  error,
  inputRef,
  onChangeText,
  onSubmit,
  onBlur,
  onOpenKeyboard,
}: {
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
}) {
  const inputText = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: color.dark21, padding: 0 } as const;
  return (
    <View style={{ flex: 1, alignSelf: 'stretch', gap: 8 }}>
      {/* obraz (podgląd edytowanego zdjęcia) */}
      <View style={{ flex: 1, alignSelf: 'stretch', borderRadius: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
        <RNImage source={source} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
        {/* nakładka przetwarzania */}
        {processing ? (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(26,26,26,0.55)' }}>
            <Text style={{ fontFamily: font.monoLabel.family, fontSize: 14, letterSpacing: 2, color: screen.olive.primary, ...phosphorGlow }}>
              PROCESSING…
            </Text>
          </View>
        ) : null}
      </View>

      {/* komunikat błędu (edycja się nie powiodła) */}
      {error ? (
        <Text style={{ fontFamily: font.caption.family, fontSize: font.caption.size, color: color.recordRed, textAlign: 'center' }}>
          {error}
        </Text>
      ) : null}

      {/* pole promptu — jasna pigułka fosforowa; tap otwiera klawiaturę, w trybie pisania = TextInput */}
      <View style={{ alignSelf: 'stretch', backgroundColor: screen.olive.primary, borderRadius: 2, padding: 6, ...({ boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any) }}>
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
    </View>
  );
}
