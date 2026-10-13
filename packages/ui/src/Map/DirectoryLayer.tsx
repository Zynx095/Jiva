import { useEffect, useMemo, useRef } from 'react';
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { useMap } from './MapContext';
import { Icon } from '../components/Icon';
import { coordinateBasis, directorySourceLabel, facilityCategoryLabel, specialtyHintLabel, type DirectoryFacility } from '../lib/directory';

const SOURCE_ID = 'jiva-directory';
const LAYER_ID = 'jiva-directory-points';

/**
 * Public directory facilities as one light GeoJSON circle layer (hundreds of points, no DOM markers).
 * Neutral gray on purpose: these facilities are listed, not connected — they carry no acceptance colour.
 * A contributor-typed location gets an amber ring.
 */
export function DirectoryLayer({ facilities, visible = true, selectedId, onSelect }: {
  facilities: DirectoryFacility[];
  visible?: boolean;
  selectedId?: string | null;
  onSelect?: (f: DirectoryFacility) => void;
}) {
  const { map, isLoaded } = useMap();
  const byId = useMemo(() => new Map(facilities.map((f) => [f.facilityId, f])), [facilities]);
  const selectRef = useRef(onSelect);
  const byIdRef = useRef(byId);
  useEffect(() => {
    selectRef.current = onSelect;
    byIdRef.current = byId;
  }, [onSelect, byId]);

  const data = useMemo<FeatureCollection<Point>>(() => ({
    type: 'FeatureCollection',
    features: facilities
      .filter((f) => f.location)
      .map((f) => ({
        type: 'Feature',
        id: f.facilityId,
        properties: { id: f.facilityId, category: f.category, status: f.coordinateStatus, selected: f.facilityId === selectedId },
        geometry: { type: 'Point', coordinates: [f.location!.longitude, f.location!.latitude] },
      })),
  }), [facilities, selectedId]);

  // Create the source and layer once per map.
  useEffect(() => {
    if (!map || !isLoaded) return;
    if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, { type: 'geojson', data });
    if (!map.getLayer(LAYER_ID)) {
      const before = ['jiva-route-alt-line', 'jiva-route-primary-casing'].find((id) => map.getLayer(id));
      map.addLayer({
        id: LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 8, ['match', ['get', 'category'], 'HOSPITAL', 5, 'SPECIALTY_HOSPITAL', 4.5, 'MATERNITY_HOME', 4.5, 3.5]],
          'circle-color': ['match', ['get', 'category'], 'HOSPITAL', '#545c53', 'SPECIALTY_HOSPITAL', '#636b62', 'MATERNITY_HOME', '#636b62', '#9a9f96'],
          'circle-stroke-color': ['case', ['get', 'selected'], '#202820', ['==', ['get', 'status'], 'MANUAL_UNVERIFIED'], '#9c6b1f', '#ffffff'],
          'circle-stroke-width': ['case', ['get', 'selected'], 2.5, 1.5],
          'circle-opacity': 0.9,
        },
      }, before);
    }
    let prevCursor = '';
    const onEnter = () => {
      prevCursor = map.getCanvas().style.cursor;
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = prevCursor;
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const f = id ? byIdRef.current.get(id) : undefined;
      if (f) selectRef.current?.(f);
    };
    map.on('mouseenter', LAYER_ID, onEnter);
    map.on('mouseleave', LAYER_ID, onLeave);
    map.on('click', LAYER_ID, onClick);
    return () => {
      map.off('mouseenter', LAYER_ID, onEnter);
      map.off('mouseleave', LAYER_ID, onLeave);
      map.off('click', LAYER_ID, onClick);
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded]);

  useEffect(() => {
    if (!map || !isLoaded) return;
    (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(data);
  }, [map, isLoaded, data]);

  useEffect(() => {
    if (!map || !isLoaded || !map.getLayer(LAYER_ID)) return;
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }, [map, isLoaded, visible]);

  return null;
}

/** What a directory listing says — and, as clearly, what it does not. */
export function DirectoryFacilityDetails({ facility, distanceKm }: { facility: DirectoryFacility; distanceKm?: number }) {
  const f = facility;
  const hint = specialtyHintLabel(f.specialtyHint);
  return (
    <div className="space-y-1.5 text-xs">
      <p className="pr-2 text-sm font-semibold leading-5 text-ink-900">{f.name}</p>
      <p className="font-semibold text-ink-700">
        {facilityCategoryLabel(f.category)}
        {hint && <span className="font-normal text-ink-500"> · {hint} (from its name)</span>}
        {distanceKm !== undefined && <span className="font-normal text-ink-500"> · {distanceKm.toFixed(1)} km straight line</span>}
      </p>
      <p className="text-ink-600">{f.address.fullAddress || 'Address not listed'}{f.address.pincode ? ` · ${f.address.pincode}` : ''}</p>
      {f.phone && (
        <p className="text-ink-600">
          Listed phone: <a className="font-semibold text-brand-700 hover:underline" href={`tel:${f.phone.replace(/[^\d+]/g, '')}`}>{f.phone}</a>
        </p>
      )}
      <p className="text-ink-500">{coordinateBasis(f)}</p>
      <p className="text-ink-500">Listed in: {[...new Set(f.sources.map((s) => directorySourceLabel(s.sourceId)))].join('; ')}</p>
      <p className="flex items-start gap-1 rounded-md bg-ink-50 px-2 py-1.5 text-ink-700 ring-1 ring-inset ring-ink-200">
        <Icon name="info" size={13} className="mt-px shrink-0" />
        <span>Not connected to JIVA: it cannot receive a referral here, and its services, beds and capacity are unknown. Call ahead.</span>
      </p>
    </div>
  );
}

