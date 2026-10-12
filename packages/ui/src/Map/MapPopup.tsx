import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Popup as MapLibrePopup } from 'maplibre-gl';
import { useMap } from './MapContext';

export interface MapPopupProps {
  lat: number;
  lng: number;
  onClose: () => void;
  children: React.ReactNode;
  /** Pixel distance from the anchor point (clears the marker). */
  offset?: number;
}

/** A small React card anchored to a map position. Escape closes it; the map's background click should too. */
export function MapPopup({ lat, lng, onClose, children, offset = 22 }: MapPopupProps) {
  const { map, isLoaded } = useMap();
  const [container] = useState(() => document.createElement('div'));
  const popupRef = useRef<MapLibrePopup | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!map || !isLoaded) return;
    const popup = new MapLibrePopup({ offset, closeButton: false, closeOnClick: false, maxWidth: '320px', focusAfterOpen: false })
      .setLngLat([lng, lat])
      .setDOMContent(container)
      .addTo(map);
    popupRef.current = popup;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      popup.remove();
      popupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, container]);

  useEffect(() => {
    popupRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  return createPortal(children, container);
}
