import React, { useEffect, useRef } from 'react';
import { Marker as MapLibreMarker } from 'maplibre-gl';
import { useMap } from './MapContext';
import { iconSvg } from '../components/Icon';
import { ambulanceStatus } from '../lib/status';

const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export interface AmbulanceMarkerProps {
  ambulanceId: string;
  lat: number;
  lng: number;
  status?: string;
  onClick?: () => void;
  selected?: boolean;
  /** Extra line in the hover label, e.g. "→ Hebbal · 12 min". */
  detail?: string;
}

/** Idle units sit beside their station so they never hide a hospital marker. */
const IDLE_OFFSET: [number, number] = [18, -16];

/**
 * Ambulance marker. On a job it is a dark pill with its call sign; idle it is a small chip.
 * Position updates glide (≈0.9 s) from wherever the marker currently is, so GPS fixes read as motion.
 */
export const AmbulanceMarker: React.FC<AmbulanceMarkerProps> = ({ ambulanceId, lat, lng, status = 'EN_ROUTE', onClick, selected, detail }) => {
  const { map, isLoaded } = useMap();
  const markerRef = useRef<MapLibreMarker | null>(null);
  const elRef = useRef<HTMLButtonElement | null>(null);
  const shown = useRef<[number, number]>([lng, lat]);
  const clickRef = useRef(onClick);
  useEffect(() => {
    clickRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!map || !isLoaded) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'jiva-mk jiva-mk--ambulance';
    el.dataset.ambulanceId = ambulanceId;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      clickRef.current?.();
    });
    elRef.current = el;
    shown.current = [lng, lat];
    const marker = new MapLibreMarker({ element: el }).setLngLat([lng, lat]).addTo(map);
    markerRef.current = marker;
    return () => {
      marker.remove();
      markerRef.current = null;
      elRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, ambulanceId]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // Idle and arrived units are parked at a station or hospital: compact, offset so the hospital stays visible.
    const idle = status === 'AVAILABLE' || status === 'ARRIVED';
    const meta = ambulanceStatus(status);
    el.dataset.idle = idle ? 'true' : 'false';
    el.dataset.arrived = status === 'ARRIVED' ? 'true' : 'false';
    el.dataset.selected = selected ? 'true' : 'false';
    el.style.zIndex = selected ? '4' : idle ? '1' : '2';
    el.setAttribute('aria-label', `Ambulance ${ambulanceId}: ${meta.label}${detail ? `, ${detail}` : ''}`);
    el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    markerRef.current?.setOffset(idle ? IDLE_OFFSET : [0, 0]);
    el.innerHTML = idle
      ? `<span class="jiva-mk__body">${iconSvg(status === 'ARRIVED' ? 'pin' : 'ambulance', 14, 2)}</span>
         <span class="jiva-mk__label">${escapeHtml(ambulanceId)}<small>${escapeHtml(meta.label)}${detail ? ` ${escapeHtml(detail)}` : ''}</small></span>`
      : `<span class="jiva-mk__body">${iconSvg('ambulance', 15, 2)}<span>${escapeHtml(ambulanceId)}</span><span class="jiva-mk__dot"></span></span>
         <span class="jiva-mk__label">${escapeHtml(meta.label)}${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>`;
  }, [map, isLoaded, ambulanceId, status, selected, detail]);

  // Glide to each new fix from the currently displayed position.
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const from = shown.current;
    const to: [number, number] = [lng, lat];
    if ((from[0] === to[0] && from[1] === to[1]) || reducedMotion()) {
      shown.current = to;
      marker.setLngLat(to);
      return;
    }
    const start = performance.now();
    const duration = 900;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      shown.current = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      marker.setLngLat(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [lat, lng]);

  return null;
};
