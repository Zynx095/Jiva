import React, { useEffect, useRef } from 'react';
import { Marker as MapLibreMarker } from 'maplibre-gl';
import { useMap } from './MapContext';
import { iconSvg } from '../components/Icon';

const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export interface EmergencyMarkerProps {
  patientId: string;
  lat: number;
  lng: number;
  condition?: string;
  onClick?: () => void;
  selected?: boolean;
  /** Pulse only while the case still needs a destination or is in progress. */
  active?: boolean;
}

/** Where the emergency was reported: a red point with a soft ring while the case is active. */
export const EmergencyMarker: React.FC<EmergencyMarkerProps> = ({ patientId, lat, lng, condition = 'Emergency', onClick, selected, active = true }) => {
  const { map, isLoaded } = useMap();
  const markerRef = useRef<MapLibreMarker | null>(null);
  const elRef = useRef<HTMLButtonElement | null>(null);
  const clickRef = useRef(onClick);
  useEffect(() => {
    clickRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!map || !isLoaded) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'jiva-mk jiva-mk--emergency';
    el.dataset.caseId = patientId;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      clickRef.current?.();
    });
    elRef.current = el;
    const marker = new MapLibreMarker({ element: el }).setLngLat([lng, lat]).addTo(map);
    markerRef.current = marker;
    return () => {
      marker.remove();
      markerRef.current = null;
      elRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, patientId]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.dataset.selected = selected ? 'true' : 'false';
    el.style.zIndex = selected ? '4' : '2';
    el.setAttribute('aria-label', `Emergency ${patientId}: ${condition}`);
    el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    el.innerHTML = `
      ${active ? '<span class="jiva-mk__ring"></span>' : ''}
      <span class="jiva-mk__body">${iconSvg('siren', 12, 2.4)}</span>
      <span class="jiva-mk__label">${escapeHtml(patientId)}<small>${escapeHtml(condition)}</small></span>`;
  }, [map, isLoaded, patientId, condition, selected, active]);

  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  return null;
};
