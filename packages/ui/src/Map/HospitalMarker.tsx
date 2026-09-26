import React, { useEffect, useRef } from 'react';
import { Marker as MapLibreMarker, Popup as MapLibrePopup } from 'maplibre-gl';
import { useMap } from './MapContext';

const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));


export interface HospitalMarkerProps {
  hospitalId: string;
  name: string;
  lat: number;
  lng: number;
  emergencyStatus: string;
  dataStatus?: string;
  onClick?: () => void;
}

export const HospitalMarker: React.FC<HospitalMarkerProps> = ({
  hospitalId,
  name,
  lat,
  lng,
  emergencyStatus,
  dataStatus,
  onClick,
}) => {
  const { map, isLoaded } = useMap();
  const markerRef = useRef<MapLibreMarker | null>(null);

  // Status color mapping
  const getPinColor = (status: string) => {
    switch (status) {
      case 'ACCEPTED':
        return '#10B981'; // Emerald
      case 'LIMITED':
        return '#F59E0B'; // Amber
      case 'REJECTED':
        return '#EF4444'; // Red
      case 'UNAVAILABLE':
        return '#DC2626'; // Dark Red
      default:
        return '#6B7280'; // Neutral grey: UNKNOWN / no current response (never implies available)
    }
  };

  useEffect(() => {
    if (!map || !isLoaded) return;

    // Create marker DOM element
    const el = document.createElement('div');
    el.className = 'jiva-hospital-marker cursor-pointer group transition-transform hover:scale-110';
    el.dataset.hospitalId = hospitalId;
    el.title = `${name} (${hospitalId})`;
    el.style.width = '32px';
    el.style.height = '32px';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';

    const color = getPinColor(emergencyStatus);

    el.innerHTML = `
      <div style="
        position: relative;
        background: ${color};
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid white;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
      ">
        <span style="
          transform: rotate(45deg);
          font-size: 13px;
          font-weight: 900;
          color: white;
        ">🏥</span>
      </div>
    `;

    // Popup content
    const popupHtml = `
      <div style="font-family: sans-serif; padding: 6px 2px; color: #111;">
        <div style="font-weight: 700; font-size: 13px; margin-bottom: 4px;">${escapeHtml(name)}</div>
        <div style="font-size: 11px; margin-bottom: 4px;">
          Status: <strong style="color: ${color};">${escapeHtml(emergencyStatus)}</strong>
        </div>
        ${
          dataStatus === 'SYNTHETIC_DEMO'
            ? `<div style="font-size: 10px; color: #D97706; font-weight: 600;">DEMO / SYNTHETIC DATA</div>`
            : `<div style="font-size: 10px; color: #059669; font-weight: 600;">PROVENANCE: ${escapeHtml(dataStatus || 'UNVERIFIED')}</div>`
        }
      </div>
    `;

    const popup = new MapLibrePopup({ offset: 25, closeButton: true })
      .setHTML(popupHtml);

    if (onClick) {
      el.addEventListener('click', onClick);
    }

    const marker = new MapLibreMarker({ element: el })
      .setLngLat([lng, lat])
      .setPopup(popup)
      .addTo(map);

    markerRef.current = marker;

    return () => {
      marker.remove();
      markerRef.current = null;
    };
  }, [map, isLoaded, lat, lng, name, emergencyStatus, dataStatus]);

  // Update position if coordinates change
  useEffect(() => {
    if (markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
    }
  }, [lat, lng]);

  return null;
};
