/**
 * Mockowe foldery — WERSJA NATYWNA (Android/iOS): PUSTO.
 * Na urządzeniu galeria używa realnych mediów (`DESIGN=false`), więc mocki są nieużywane — trzymamy je
 * poza buildem natywnym, żeby `require()` dużych obrazków z `assets/mock/` nie wpychał ~15 MB do APK.
 * Realne mocki (z `require`) są w bliźniaczym `mockFolders.web.ts` (Metro wybiera go tylko na web).
 */
import type { ImageSourcePropType } from 'react-native';

export type Folder = { id: string; name: string; cover?: ImageSourcePropType; count?: number; photos?: ImageSourcePropType[] };

export const MOCK_FOLDERS: Folder[] = [];
