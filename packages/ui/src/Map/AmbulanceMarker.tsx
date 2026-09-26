import React, { useEffect, useRef } from 'react';
import { Marker as MapLibreMarker } from 'maplibre-gl';
import { useMap } from './MapContext';

const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));


export interface AmbulanceMarkerProps {
  ambulanceId: string;
  lat: number;
  lng: number;
  status?: string;
}

export const AmbulanceMarker: React.FC<AmbulanceMarkerProps> = ({
  ambulanceId,
  lat,
  lng,
  status = 'EN_ROUTE',
}) => {
  const { map, isLoaded } = useMap();
  const markerRef = useRef<MapLibreMarker | null>(null);

  useEffect(() => {
    if (!map || !isLoaded) return;

    // Create marker DOM element
    const el = document.createElement('div');
    el.className = 'jiva-ambulance-marker cursor-pointer transition-transform hover:scale-105';
    el.title = `${ambulanceId} (${status})`;
    el.dataset.status = status;
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.gap = '6px';
    el.style.background = '#065F46'; // Emerald 800
    el.style.color = '#ECFDF5';
    el.style.padding = '4px 10px';
    el.style.borderRadius = '9999px';
    el.style.fontSize = '12px';
    el.style.fontWeight = 'bold';
    el.style.border = '2px solid #34D399'; // Emerald 400
    el.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 0 12px rgba(52, 211, 153, 0.4)';
    el.style.whiteSpace = 'nowrap';
    el.style.fontFamily = 'monospace';

    el.innerHTML = `
      <span style="font-size: 14px;">🚑</span>
      <span>${escapeHtml(ambulanceId)}</span>
      <span style="
        width: 6px;
        height: 6px;
        background: #34D399;
        border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 6px #34D399;
      "></span>
    `;

    const marker = new MapLibreMarker({ element: el })
      .setLngLat([lng, lat])
      .addTo(map);

    markerRef.current = marker;

    return () => {
      marker.remove();
      markerRef.current = null;
    };
  }, [map, isLoaded, ambulanceId]);

  // Smooth live position update without DOM recreation
  useEffect(() => {
    if (markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
    }
  }, [lat, lng]);

  return null;
};
