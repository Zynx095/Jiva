import React, { useEffect, useRef } from 'react';
import { Marker as MapLibreMarker } from 'maplibre-gl';
import { useMap } from './MapContext';
import { iconSvg } from '../components/Icon';
import { acceptanceStatus } from '../lib/status';
import { hospitalShortName } from '../lib/labels';

const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export interface HospitalMarkerProps {
  hospitalId: string;
  name: string;
  lat: number;
  lng: number;
  /** Acceptance state (ACCEPTED, LIMITED, PENDING, REJECTED, UNAVAILABLE, EXPIRED, UNKNOWN). */
  emergencyStatus: string;
  dataStatus?: string;
  onClick?: () => void;
  selected?: boolean;
  /** De-emphasise (filtered context, not the destination). */
  dimmed?: boolean;
  /** Short name shown in the hover label; defaults to the part after "—". */
  label?: string;
  /** Overrides the status text in the label/announcement. */
  statusLabel?: string;
}

/**
 * Rounded-square hospital marker. Colour = acceptance tone, the corner glyph repeats it, and the label
 * spells it out, so the status never depends on colour alone.
 */
export const HospitalMarker: React.FC<HospitalMarkerProps> = ({
  hospitalId,
  name,
  lat,
  lng,
  emergencyStatus,
  dataStatus,
  onClick,
  selected,
  dimmed,
  label,
  statusLabel,
}) => {
  const { map, isLoaded } = useMap();
  const markerRef = useRef<MapLibreMarker | null>(null);
  const elRef = useRef<HTMLButtonElement | null>(null);
  const clickRef = useRef(onClick);
  useEffect(() => {
    clickRef.current = onClick;
  }, [onClick]);

  // Create once per map; later prop changes only touch attributes (no flicker, no re-mount).
  useEffect(() => {
    if (!map || !isLoaded) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'jiva-mk jiva-mk--hospital';
    el.dataset.hospitalId = hospitalId;
    el.addEventListener('click', (e) => {
      e.stopPropagation(); // keep the map's background click (deselect) from firing
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
  }, [map, isLoaded, hospitalId]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const meta = acceptanceStatus(emergencyStatus);
    const text = statusLabel ?? meta.label;
    const short = label ?? hospitalShortName(name);
    const demo = dataStatus === 'SYNTHETIC_DEMO' ? ' (demo data)' : '';
    el.dataset.tone = meta.tone;
    el.dataset.selected = selected ? 'true' : 'false';
    el.dataset.dimmed = dimmed ? 'true' : 'false';
    el.style.zIndex = selected ? '3' : '1';
    // The accessible name starts with the visible label (WCAG 2.5.3), then the full name.
    el.setAttribute('aria-label', `${short} ${text}${name !== short ? ` — ${name}` : ''}${demo}`);
    el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    el.innerHTML = `
      <span class="jiva-mk__body"><svg class="jiva-mk__h" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 1.5v9M9.5 1.5v9M2.5 6h7" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg></span>
      <span class="jiva-mk__badge">${iconSvg(meta.icon, 11, 2.6)}</span>
      <span class="jiva-mk__label">${escapeHtml(short)} <small>${escapeHtml(text)}</small></span>`;
  }, [map, isLoaded, hospitalId, emergencyStatus, statusLabel, label, name, selected, dimmed, dataStatus]);

  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  return null;
};
