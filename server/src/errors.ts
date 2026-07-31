/**
 * errors.ts — klasy błędów, po których proxy rozpoznaje, KTO zawinił. Bez tego wszystko, co nie miało
 * pola `status`, lądowało w apce jako `502 "<trasa> failed (upstream)"` — czyli uszkodzony plik od
 * użytkownika albo naruszona asercja w naszym kodzie udawały awarię deAPI i sugerowały „spróbuj później",
 * mimo że ponowienie nic nie zmieni.
 */

/** Wina ŻĄDANIA (uszkodzony obraz, pusta/za ciężka maska). Treść jest nasza i wolno ją pokazać użytkownikowi. */
export class BadRequest extends Error {
  status = 400;
}

/** Wina PROXY — naruszona asercja wewnętrzna. Nie udawaj awarii deAPI; szczegóły zostają w logach. */
export class ProxyError extends Error {
  status = 500;
}
