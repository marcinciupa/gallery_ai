import { requireOptionalNativeModule } from 'expo';

type MediaManageModule = {
  isSupported(): boolean;
  canManageMedia(): boolean;
  openSettings(): boolean;
};

// Opcjonalny: na webie (podgląd designu) i w Expo Go modułu nie ma — wtedy zachowujemy się jak Android 11
// (nie pytamy, systemowe okna zgody zostają).
export default requireOptionalNativeModule<MediaManageModule>('MediaManage');
