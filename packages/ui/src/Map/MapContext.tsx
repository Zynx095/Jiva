import { createContext, useContext } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

export interface MapContextValue {
  map: MapLibreMap | null;
  isLoaded: boolean;
}

export const MapContext = createContext<MapContextValue>({
  map: null,
  isLoaded: false,
});

export const useMap = () => useContext(MapContext);
