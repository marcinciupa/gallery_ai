/**
 * Długość wideo → napis na kafelku i w panelu INFO.
 *
 * ⚠️ JEDNOSTKA: `AssetMetadata.duration` z expo-media-library (nowe API) to SUROWA kolumna
 * `MediaStore.DURATION`, czyli MILISEKUNDY — natywny kod (`MediaStoreVideo.kt`) czyta ją przez
 * `getNullableLong` i niczego nie przelicza. Legacy API oddawało sekundy, więc łatwo się pomylić:
 * 42-sekundowy film pokazałby się jako 11 godzin. Cała apka trzyma milisekundy.
 */

/** `142000` → `"2:22"`, `3742000` → `"1:02:22"`. Null/0/ujemne → `null` (nie ma czego rysować). */
export function formatDuration(ms?: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
