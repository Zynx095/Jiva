import React, { useEffect, useRef, useState } from 'react';
import {
  Map as MapLibreMap,
  LngLatBounds,
  NavigationControl,
  AttributionControl,
  GeoJSONSource,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl v6 resolves its worker as a sibling file of the library, which does not exist
// once Vite bundles the library. Let Vite bundle the worker (with its shared chunk) and pass the URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);
import { MapContext } from './MapContext';

export interface RouteMetadata {
  provider?: string;
  sourceType?: string;
  synthetic?: boolean;
  trafficAware?: boolean;
  distanceMeters?: number;
  durationSeconds?: number;
}

export interface JivaMapProps {
  center?: { lat: number; lng: number };
  zoom?: number;
  routeCoordinates?: [number, number][]; // GeoJSON [lng, lat]
  alternativeRouteCoordinates?: [number, number][][];
  routeMetadata?: RouteMetadata;
  fitBoundsOnUpdate?: boolean;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  // Backwards-compatible legacy props (ignored in MapLibre)
  apiKey?: string;
  mapId?: string;
}

const BENGALURU_CENTER = { lat: 12.9716, lng: 77.5946 };

export const JivaMap: React.FC<JivaMapProps> = ({
  center = BENGALURU_CENTER,
  zoom = 11,
  routeCoordinates,
  alternativeRouteCoordinates,
  routeMetadata,
  fitBoundsOnUpdate = false,
  style,
  className = '',
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Initialize MapLibre
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: [
              'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        layers: [
          {
            id: 'osm-tiles',
            type: 'raster',
            source: 'osm',
            minzoom: 0,
            maxzoom: 19,
          },
        ],
      },
      center: [center.lng, center.lat],
      zoom: zoom,
      attributionControl: false, // Custom attribution control added below
    });

    // Add navigation and attribution controls
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(
      new AttributionControl({
        compact: false,
        customAttribution: '© OpenStreetMap contributors',
      }),
      'bottom-left'
    );

    map.on('load', () => {
      setIsLoaded(true);
      map.resize();
    });

    setMapInstance(map);

    // Responsive resize handler
    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      setMapInstance(null);
      setIsLoaded(false);
    };
  }, []);

  // Update center when center prop changes
  useEffect(() => {
    if (mapInstance && isLoaded && center) {
      // Smoothly pan if within reasonable distance
      mapInstance.easeTo({
        center: [center.lng, center.lat],
        duration: 1000,
      });
    }
  }, [center.lat, center.lng, mapInstance, isLoaded]);

  // Primary Route Layer
  useEffect(() => {
    if (!mapInstance || !isLoaded) return;

    const sourceId = 'jiva-route-primary';
    const layerId = 'jiva-route-primary-line';
    const casingLayerId = 'jiva-route-primary-casing';

    const coords = routeCoordinates && routeCoordinates.length >= 2 ? routeCoordinates : [];

    const geojsonData: any = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: coords,
      },
    };

    const existingSource = mapInstance.getSource(sourceId) as GeoJSONSource | undefined;

    if (existingSource) {
      existingSource.setData(geojsonData);
    } else if (coords.length >= 2) {
      mapInstance.addSource(sourceId, {
        type: 'geojson',
        data: geojsonData,
      });

      // Outer casing for contrast
      mapInstance.addLayer({
        id: casingLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#1E3A8A',
          'line-width': 8,
          'line-opacity': 0.8,
        },
      });

      // Inner route line
      mapInstance.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#3B82F6',
          'line-width': 5,
          'line-opacity': 0.95,
        },
      });
    }

    // Camera fitting
    if (fitBoundsOnUpdate && coords.length >= 2) {
      const bounds = new LngLatBounds();
      coords.forEach((c) => bounds.extend(c));
      mapInstance.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1200 });
    }
  }, [mapInstance, isLoaded, routeCoordinates, fitBoundsOnUpdate]);

  // Alternative Routes Layer
  useEffect(() => {
    if (!mapInstance || !isLoaded) return;

    const sourceId = 'jiva-route-alt';
    const layerId = 'jiva-route-alt-line';

    const altLines = (alternativeRouteCoordinates || []).filter((line) => line.length >= 2);

    const geojsonData: any = {
      type: 'FeatureCollection',
      features: altLines.map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: line,
        },
      })),
    };

    const existingSource = mapInstance.getSource(sourceId) as GeoJSONSource | undefined;

    if (existingSource) {
      existingSource.setData(geojsonData);
    } else if (altLines.length > 0) {
      mapInstance.addSource(sourceId, {
        type: 'geojson',
        data: geojsonData,
      });

      mapInstance.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#9CA3AF',
          'line-width': 4,
          'line-dasharray': [2, 2],
          'line-opacity': 0.7,
        },
      });
    }
  }, [mapInstance, isLoaded, alternativeRouteCoordinates]);

  // Determine provider label for HUD
  const providerLabel = (() => {
    if (!routeMetadata?.provider && (!routeCoordinates || routeCoordinates.length === 0)) {
      return { text: 'OpenStreetMap (Bengaluru)', badge: 'OSM', color: 'bg-emerald-900/80 text-emerald-300 border-emerald-700' };
    }
    const p = (routeMetadata?.provider || 'mock').toLowerCase();
    if (p === 'valhalla') {
      return { text: 'Route: OpenStreetMap / Valhalla', badge: 'VALHALLA', color: 'bg-emerald-900/80 text-emerald-300 border-emerald-700' };
    }
    if (p === 'osrm') {
      return { text: 'Route: OSRM (Road-Network)', badge: 'OSRM', color: 'bg-blue-900/80 text-blue-300 border-blue-700' };
    }
    return { text: 'Synthetic demo route (mock provider, not road-network)', badge: 'SYNTHETIC', color: 'bg-amber-900/80 text-amber-300 border-amber-700' };
  })();

  return (
    <div
      className={`overflow-hidden ${className}`}
      // Fills its (positioned) parent. `h-full` inside flex items resolves to 0/min-height.
      style={{ position: 'absolute', inset: 0, minHeight: '300px', ...style }}
    >
      {/* Absolutely positioned so the map always fills the wrapper (a % height of a min-height parent resolves to 0). */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* MapLibre Route Provider & Transparency HUD Badge */}
      <div className="absolute top-3 left-3 z-10 pointer-events-none">
        <div
          className={`flex items-center gap-2 px-2.5 py-1 rounded-md text-[11px] font-mono border backdrop-blur-md shadow-lg ${providerLabel.color}`}
        >
          <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
          <span className="font-semibold">{providerLabel.text}</span>
          {!!routeMetadata?.durationSeconds && (
            <span className="text-[10px] opacity-80">
              ({Math.ceil(routeMetadata.durationSeconds / 60)} min{routeMetadata.trafficAware ? '' : ', no live traffic'})
            </span>
          )}
        </div>
      </div>

      <MapContext.Provider value={{ map: mapInstance, isLoaded }}>
        {children}
      </MapContext.Provider>
    </div>
  );
};
