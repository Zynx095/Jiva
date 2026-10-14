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
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { MapContext } from './MapContext';
import { Icon } from '../components/Icon';
import { cx } from '../lib/cx';
import { minutesFromSeconds } from '../lib/time';

setWorkerUrl(maplibreWorkerUrl);

export interface RouteMetadata {
  provider?: string;
  sourceType?: string;
  synthetic?: boolean;
  trafficAware?: boolean;
  distanceMeters?: number;
  durationSeconds?: number;
}

/** Fly the camera to a point whenever `key` changes. */
export interface MapFocus {
  lat: number;
  lng: number;
  zoom?: number;
  key: string | number;
  /** Pixel offset of the target from the map centre; positive y leaves room above for a popup. */
  offset?: [number, number];
}

/** Fit the camera to coordinates ([lng, lat]) whenever `key` changes. */
export interface MapFit {
  coordinates: [number, number][];
  key: string | number;
  maxZoom?: number;
  /** Extra room for overlays (pixels); defaults to 70 on every side. */
  padding?: number | { top: number; bottom: number; left: number; right: number };
  /** Jump without animation (first load). */
  instant?: boolean;
}

export interface JivaMapProps {
  center?: { lat: number; lng: number };
  zoom?: number;
  routeCoordinates?: [number, number][]; // GeoJSON [lng, lat]
  /** Dashed, muted lines: alternatives or the route that was just abandoned in a reroute. */
  alternativeRouteCoordinates?: [number, number][][];
  routeMetadata?: RouteMetadata;
  fitBoundsOnUpdate?: boolean;
  focus?: MapFocus | null;
  fit?: MapFit | null;
  /** Click on empty map (not a marker). */
  onBackgroundClick?: () => void;
  /**
   * Location picking: when set, a click on the map reports the clicked point and the cursor becomes a
   * crosshair. Markers keep their own click behaviour.
   */
  onPick?: (point: { lat: number; lng: number }) => void;
  /** Overlay slots. Top-right holds the camera tools; bottom-right the zoom and attribution. */
  topLeft?: React.ReactNode;
  bottomLeft?: React.ReactNode;
  /** Show "recenter" and "fit route" tools. */
  tools?: boolean;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  /** Accessible description of what the map shows. */
  label?: string;
  // Backwards-compatible legacy props (ignored in MapLibre)
  apiKey?: string;
  mapId?: string;
}

const BENGALURU_CENTER = { lat: 12.9716, lng: 77.5946 };

/*
 * Clinical basemap. Same OpenStreetMap raster tiles as before, re-toned in the GPU so data reads first:
 * desaturated, lifted and softened (in the spirit of "Subtle Grayscale" / "Ultra Light" styles).
 * Hospitals, ambulances, emergencies and the active route carry the only strong colour on the map.
 */
const BASEMAP_PAINT = {
  'raster-saturation': -0.9,
  'raster-contrast': -0.2,
  'raster-brightness-min': 0.22,
  'raster-brightness-max': 1,
  'raster-opacity': 0.78,
  'raster-fade-duration': 200,
} as const;

const ROUTE_COLOR = '#1b573c'; // brand-800: high contrast on the pale basemap
const ROUTE_CASING = '#ffffff';
const ALT_ROUTE_COLOR = '#9a9f96'; // ink-400

function boundsOf(coords: [number, number][]): LngLatBounds {
  const b = new LngLatBounds();
  coords.forEach((c) => b.extend(c));
  return b;
}

function MapToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center bg-white text-ink-700 transition-colors hover:bg-ink-50 hover:text-ink-900 disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-white"
    >
      {children}
    </button>
  );
}

export const JivaMap: React.FC<JivaMapProps> = ({
  center = BENGALURU_CENTER,
  zoom = 11,
  routeCoordinates,
  alternativeRouteCoordinates,
  routeMetadata,
  fitBoundsOnUpdate = false,
  focus,
  fit,
  onBackgroundClick,
  onPick,
  topLeft,
  bottomLeft,
  tools = true,
  style,
  className = '',
  children,
  label = 'Map',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const backgroundClick = useRef(onBackgroundClick);
  useEffect(() => {
    backgroundClick.current = onBackgroundClick;
  }, [onBackgroundClick]);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  // Crosshair cursor while picking a location.
  useEffect(() => {
    if (!mapInstance) return;
    mapInstance.getCanvas().style.cursor = onPick ? 'crosshair' : '';
  }, [mapInstance, onPick]);

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
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        layers: [
          { id: 'jiva-background', type: 'background', paint: { 'background-color': '#f7f5f0' } },
          { id: 'osm-tiles', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 19, paint: { ...BASEMAP_PAINT } },
        ],
      },
      center: [center.lng, center.lat],
      zoom: zoom,
      attributionControl: false, // Custom attribution control added below
    });

    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new AttributionControl({ compact: false, customAttribution: '© OpenStreetMap contributors' }), 'bottom-right');

    map.on('load', () => {
      setIsLoaded(true);
      map.resize();
    });
    map.on('click', (e) => {
      backgroundClick.current?.();
      pick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
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
      mapInstance.easeTo({ center: [center.lng, center.lat], duration: 1000 });
    }
  }, [center.lat, center.lng, mapInstance, isLoaded]);

  // Declarative camera moves: focus a point / fit a set of coordinates.
  useEffect(() => {
    if (!mapInstance || !isLoaded || !focus) return;
    mapInstance.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(mapInstance.getZoom(), focus.zoom ?? 13), duration: 900, offset: focus.offset ?? [0, 0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, isLoaded, focus?.key]);

  useEffect(() => {
    if (!mapInstance || !isLoaded || !fit || fit.coordinates.length === 0) return;
    if (fit.coordinates.length === 1) {
      const [lng, lat] = fit.coordinates[0];
      mapInstance.flyTo({ center: [lng, lat], zoom: Math.max(mapInstance.getZoom(), 13), duration: 900 });
    } else {
      mapInstance.fitBounds(boundsOf(fit.coordinates), { padding: fit.padding ?? 70, maxZoom: fit.maxZoom ?? 14, duration: fit.instant ? 0 : 1000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, isLoaded, fit?.key]);

  // Primary Route Layer
  useEffect(() => {
    if (!mapInstance || !isLoaded) return;

    const sourceId = 'jiva-route-primary';
    const layerId = 'jiva-route-primary-line';
    const casingLayerId = 'jiva-route-primary-casing';

    const coords = routeCoordinates && routeCoordinates.length >= 2 ? routeCoordinates : [];
    const geojsonData: Feature<LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    };

    const existingSource = mapInstance.getSource(sourceId) as GeoJSONSource | undefined;

    if (existingSource) {
      existingSource.setData(geojsonData);
    } else if (coords.length >= 2) {
      mapInstance.addSource(sourceId, { type: 'geojson', data: geojsonData });
      // White casing keeps the route legible over any basemap feature.
      mapInstance.addLayer({
        id: casingLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ROUTE_CASING, 'line-width': 9, 'line-opacity': 0.95 },
      });
      mapInstance.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ROUTE_COLOR, 'line-width': 4.5, 'line-opacity': 0.95 },
      });
    }

    if (fitBoundsOnUpdate && coords.length >= 2) {
      mapInstance.fitBounds(boundsOf(coords), { padding: 70, maxZoom: 14, duration: 1200 });
    }
  }, [mapInstance, isLoaded, routeCoordinates, fitBoundsOnUpdate]);

  // Alternative / previous routes layer
  useEffect(() => {
    if (!mapInstance || !isLoaded) return;

    const sourceId = 'jiva-route-alt';
    const layerId = 'jiva-route-alt-line';
    const altLines = (alternativeRouteCoordinates || []).filter((line) => line.length >= 2);
    const geojsonData: FeatureCollection<LineString> = {
      type: 'FeatureCollection',
      features: altLines.map((line) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } })),
    };

    const existingSource = mapInstance.getSource(sourceId) as GeoJSONSource | undefined;
    if (existingSource) {
      existingSource.setData(geojsonData);
    } else if (altLines.length > 0) {
      mapInstance.addSource(sourceId, { type: 'geojson', data: geojsonData });
      const beforeId = mapInstance.getLayer('jiva-route-primary-casing') ? 'jiva-route-primary-casing' : undefined;
      mapInstance.addLayer(
        {
          id: layerId,
          type: 'line',
          source: sourceId,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ALT_ROUTE_COLOR, 'line-width': 3.5, 'line-dasharray': [1.5, 2], 'line-opacity': 0.85 },
        },
        beforeId,
      );
    }
  }, [mapInstance, isLoaded, alternativeRouteCoordinates]);

  const hasRoute = !!routeCoordinates && routeCoordinates.length >= 2;
  const provider = (() => {
    if (!hasRoute) return null;
    const p = (routeMetadata?.provider || 'mock').toLowerCase();
    const minutes = minutesFromSeconds(routeMetadata?.durationSeconds);
    const traffic = routeMetadata?.trafficAware ? '' : ' · no live traffic';
    if (p === 'valhalla') return { text: 'Road route', extra: ` · Valhalla${traffic}`, cls: 'bg-white text-brand-800 ring-brand-200', synthetic: false, minutes };
    if (p === 'osrm') return { text: 'Road route', extra: ` · OSRM${traffic}`, cls: 'bg-white text-brand-800 ring-brand-200', synthetic: false, minutes };
    return { text: 'Synthetic route', extra: ` · mock provider${traffic}`, cls: 'bg-warn-50 text-warn-800 ring-warn-200', synthetic: true, minutes };
  })();

  return (
    <div
      className={cx('jiva-map overflow-hidden bg-[#f7f5f0]', className)}
      // Fills its (positioned) parent. `h-full` inside flex items resolves to 0/min-height.
      style={{ position: 'absolute', inset: 0, minHeight: '300px', ...style }}
    >
      {/* Absolutely positioned so the map always fills the wrapper (a % height of a min-height parent resolves to 0). */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} role="region" aria-label={label} />

      {topLeft && <div className="pointer-events-none absolute left-3 right-16 top-3 z-10 flex flex-wrap items-start gap-2 [&>*]:pointer-events-auto">{topLeft}</div>}

      {tools && (
        <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-[10px] shadow-sm ring-1 ring-ink-200 [&>*+*]:border-t [&>*+*]:border-ink-200">
          <MapToolButton label="Recenter on Bengaluru" onClick={() => mapInstance?.flyTo({ center: [BENGALURU_CENTER.lng, BENGALURU_CENTER.lat], zoom: 11, duration: 900 })}>
            <Icon name="crosshair" size={17} />
          </MapToolButton>
          <MapToolButton
            label={hasRoute ? 'Fit route in view' : 'No active route to fit'}
            disabled={!hasRoute}
            onClick={() => routeCoordinates && mapInstance?.fitBounds(boundsOf(routeCoordinates), { padding: 70, maxZoom: 14, duration: 900 })}
          >
            <Icon name="route" size={17} />
          </MapToolButton>
        </div>
      )}

      {(bottomLeft || provider) && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-7rem)] flex-col items-start gap-2 [&>*]:pointer-events-auto">
          {bottomLeft && <div className="hidden sm:block">{bottomLeft}</div>}
          {provider && (
            <div className={cx('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold shadow-sm ring-1 ring-inset', provider.cls)}>
              <Icon name={provider.synthetic ? 'info' : 'route'} size={13} strokeWidth={2} />
              <span>
                {provider.text}
                {/* The full provider sentence on wider maps; the short label always stays visible. */}
                <span className="hidden sm:inline">{provider.extra}</span>
              </span>
              {provider.minutes !== undefined && <span className="font-medium opacity-80">· {provider.minutes} min</span>}
            </div>
          )}
        </div>
      )}

      <MapContext.Provider value={{ map: mapInstance, isLoaded }}>{children}</MapContext.Provider>
    </div>
  );
};

/** Collapsible key to the marker language (shape + colour + label, never colour alone). */
export function MapLegend({ showEmergency = true, showAmbulance = true, showDirectory = false }: { showEmergency?: boolean; showAmbulance?: boolean; showDirectory?: boolean }) {
  const row = 'flex items-center gap-2 text-xs text-ink-700';
  const sq = (bg: string, border = 'border-white') => <span className={cx('h-3.5 w-3.5 rounded-[4px] border-2', bg, border)} aria-hidden="true" />;
  return (
    <details className="group rounded-lg bg-white/95 text-ink-800 shadow-sm ring-1 ring-ink-200">
      <summary className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold">
        <Icon name="layers" size={13} />
        Legend
        <Icon name="chevronUp" size={13} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-1.5 border-t border-ink-100 px-2.5 py-2">
        <div className={row}>{sq('bg-brand-600')}Hospital accepted</div>
        <div className={row}>{sq('bg-warn-600')}Limited or awaiting answer</div>
        <div className={row}>{sq('bg-danger-600')}Declined or unavailable</div>
        <div className={row}>{sq('bg-white', 'border-ink-400')}No current response</div>
        {showAmbulance && (
          <div className={row}>
            <span className="h-3 w-5 rounded-full border-2 border-white bg-ink-900" aria-hidden="true" />
            Ambulance on a job
          </div>
        )}
        {showEmergency && (
          <div className={row}>
            <span className="h-3.5 w-3.5 rounded-full border-2 border-white bg-danger-600" aria-hidden="true" />
            Emergency location
          </div>
        )}
        <div className={row}>
          <span className="h-1 w-5 rounded-full bg-[#1b573c]" aria-hidden="true" />
          Active route
        </div>
        {showDirectory && (
          <div className={row}>
            <span className="h-2.5 w-2.5 rounded-full border border-white bg-ink-600" aria-hidden="true" />
            Listed facility · not connected
          </div>
        )}
      </div>
    </details>
  );
}
