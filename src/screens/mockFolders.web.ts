/**
 * Mockowe foldery — WERSJA WEB (podgląd/projektowanie UI bez urządzenia).
 * `require()` obrazków z `assets/mock/` bundluje je TYLKO do builda web (Metro: `*.web.ts`), więc nie
 * powiększają APK natywnego (patrz bliźniaczy `mockFolders.ts` = pusto). „Space" spięty z breadcrumbem.
 */
import type { ImageSourcePropType } from 'react-native';

export type Folder = { id: string; name: string; cover?: ImageSourcePropType; count?: number; photos?: ImageSourcePropType[] };

const SPACE_PHOTOS: ImageSourcePropType[] = [
  require('../../assets/mock/space/moon.jpg'),
  require('../../assets/mock/space/milkyway.jpg'),
  require('../../assets/mock/space/redstar.jpg'),
  require('../../assets/mock/space/forest.png'),
  require('../../assets/mock/space/nebula.jpg'),
  require('../../assets/mock/space/galaxy.jpg'),
  require('../../assets/mock/space/bluestar.jpg'),
  require('../../assets/mock/space/purple.jpg'),
  require('../../assets/mock/space/sun.jpg'),
];

export const MOCK_FOLDERS: Folder[] = [
  { id: 'space', name: 'Space', cover: require('../../assets/mock/lightroom.jpg'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'camera', name: 'Camera', cover: require('../../assets/mock/camera.jpg'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'camera_raw', name: 'Camera RAW', cover: require('../../assets/mock/camera_raw.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'nature', name: 'Nature', cover: require('../../assets/mock/nature.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'hikes', name: 'Hikes', cover: require('../../assets/mock/hikes.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'wild', name: 'Wild Animals', cover: require('../../assets/mock/wild_animals.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
  { id: 'vacations', name: 'Vacations', cover: require('../../assets/mock/vacations.png'), count: SPACE_PHOTOS.length, photos: SPACE_PHOTOS },
];
