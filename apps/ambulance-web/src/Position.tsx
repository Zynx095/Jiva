import type { AmbulanceState, HospitalState } from '@jiva/domain-models';
import { AsyncButton, CardHeader, Icon, JivaButton, JivaCard, JivaStatus, hospitalShortName, positionSource, timeAgo } from '@jiva/ui/src';
import { sendManualPosition, type Point } from './api';

/**
 * Where JIVA thinks the unit is, where that position came from, and quick ways to update it: at the scene,
 * at the destination (which lets the arrival geofence mark the unit as arrived — the hospital still records
 * the arrival itself), or anywhere by tapping the map.
 */
export function PositionCard({ ambulance, scene, destination, picking, onPickToggle, now }: {
  ambulance: AmbulanceState;
  scene?: Point;
  destination?: HospitalState | null;
  picking: boolean;
  onPickToggle: (on: boolean) => void;
  now: number;
}) {
  const meta = positionSource(ambulance.locationSource);
  const arrived = ambulance.status === 'ARRIVED';
  return (
    <JivaCard>
      <CardHeader
        title="Your position"
        icon="pin"
        subtitle={ambulance.locationAsOf ? `Updated ${timeAgo(ambulance.locationAsOf, now)}` : 'Not updated since this unit was registered'}
        actions={ambulance.locationAsOf ? <JivaStatus meta={meta} /> : undefined}
      />
      <p className="mt-2 flex items-start gap-1.5 text-[13px] text-ink-600">
        <Icon name="info" size={14} className="mt-0.5 shrink-0 text-ink-500" />
        JIVA receives no GPS from this unit. Update the position when you move — the route, the ETA and the arrival use the last position.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {scene && !arrived && ambulance.status !== 'EN_ROUTE_TO_HOSPITAL' && (
          <AsyncButton size="sm" icon="siren" pendingText="Sending…" successText="Position sent" onAction={() => sendManualPosition(ambulance.ambulanceId, scene)}>
            I'm at the scene
          </AsyncButton>
        )}
        {destination?.location && !arrived && (
          <AsyncButton
            size="sm"
            variant="primary"
            icon="hospital"
            pendingText="Sending…"
            successText="Position sent"
            onAction={() => sendManualPosition(ambulance.ambulanceId, destination.location!)}
          >
            I'm at {hospitalShortName(destination.displayName, destination.address?.locality)}
          </AsyncButton>
        )}
        <JivaButton size="sm" variant={picking ? 'secondary' : 'ghost'} icon="crosshair" aria-pressed={picking} onClick={() => onPickToggle(!picking)}>
          {picking ? 'Cancel — tap the map to set' : 'Set on the map'}
        </JivaButton>
      </div>
      {destination?.location && !arrived && (
        <p className="mt-2 text-xs text-ink-500">At the hospital, JIVA marks your unit as arrived from this position. The hospital then records the arrival and the handover.</p>
      )}
    </JivaCard>
  );
}
