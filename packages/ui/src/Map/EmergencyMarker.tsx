import React, { useEffect, useRef } from 'react';
import { Marker as MapLibreMarker, Popup as MapLibrePopup } from 'maplibre-gl';
import { useMap } from './MapContext';

export interface EmergencyMarkerProps {
  patientId: string;
  lat: number;
  lng: number;
  condition?: string;
}

export const EmergencyMarker: React.FC<EmergencyMarkerProps> = ({
  patientId,
  lat,
  lng,
  condition = 'Emergency',
}) => {
  const { map, isLoaded } = useMap();
  const markerRef = useRef<MapLibreMarker | null>(null);

  useEffect(() => {
    if (!map || !isLoaded) return;

    const el = document.createElement('div');
    el.className = 'jiva-emergency-marker cursor-pointer transition-transform hover:scale-105';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.gap = '4px';
    el.style.background = '#991B1B'; // Red 800
    el.style.color = '#FEF2F2';
    el.style.padding = '4px 8px';
    el.style.borderRadius = '9999px';
    el.style.fontSize = '11px';
    el.style.fontWeight = 'bold';
    el.style.border = '2px solid #F87171'; // Red 400
    el.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 0 12px rgba(248, 113, 113, 0.5)';
    el.style.whiteSpace = 'nowrap';

    el.innerHTML = `
      <span style="font-size: 13px;">🚨</span>
      <span>${condition}</span>
    `;

    const popup = new MapLibrePopup({ offset: 20 })
      .setHTML(`<div style="padding: 4px; font-family: sans-serif;"><strong>Patient ${patientId}</strong><br/>${condition}</div>`);

    const marker = new MapLibreMarker({ element: el })
      .setLngLat([lng, lat])
      .setPopup(popup)
      .addTo(map);

    markerRef.current = marker;

    return () => {
      marker.remove();
      markerRef.current = null;
    };
  }, [map, isLoaded, patientId, condition]);

  useEffect(() => {
    if (markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
    }
  }, [lat, lng]);

  return null;
};
