import { useDeferredValue, useMemo, useState } from 'react';
import {
  DirectoryFacilityDetails,
  EmptyState,
  Icon,
  JivaBadge,
  JivaButton,
  JivaFilter,
  SkeletonRows,
  ToggleChip,
  cx,
  facilityCategoryLabel,
  specialtyHintLabel,
  type DirectoryFacility,
  type DirectoryLoad,
  type DirectoryResponse,
} from '@jiva/ui/src';

const CATEGORY_ORDER = ['HOSPITAL', 'SPECIALTY_HOSPITAL', 'MATERNITY_HOME', 'HEALTH_CENTRE', 'NURSING_HOME', 'CLINIC', 'DIAGNOSTIC_CENTRE', 'UNKNOWN'];
const PAGE = 120;

const placement = (f: DirectoryFacility) =>
  f.coordinateStatus === 'OSM_FACILITY_MATCH'
    ? { label: 'On map', tone: 'neutral' as const, icon: 'pin' as const }
    : f.coordinateStatus === 'MANUAL_UNVERIFIED'
      ? { label: 'Unverified location', tone: 'warn' as const, icon: 'alertTriangle' as const }
      : { label: 'Not placed', tone: 'neutral' as const, icon: 'help' as const };

/**
 * Public facility directory: coverage and provenance at a glance. Listings only — none of these
 * facilities is connected to JIVA, so nothing here can receive a referral or show capacity.
 */
export function DirectoryList({ data, state, onRetry, selectedId, onSelect }: {
  data: DirectoryResponse | null;
  state: DirectoryLoad;
  onRetry: () => void;
  selectedId?: string;
  onSelect: (f: DirectoryFacility) => void;
}) {
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [placedOnly, setPlacedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const q = useDeferredValue(query.trim().toLowerCase());

  const list = useMemo(() => {
    const all = data?.facilities ?? [];
    return all
      .filter((f) => !categories.length || categories.includes(f.category))
      .filter((f) => !placedOnly || !!f.location)
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.address.fullAddress.toLowerCase().includes(q) || f.address.pincode === q);
  }, [data, categories, placedOnly, q]);

  if (state === 'loading' && !data) return <SkeletonRows rows={4} />;
  if (state === 'unavailable') {
    return <EmptyState icon="database" title="Facility directory not built" description="The API has no directory file. Run npm run directory:build and restart the API." />;
  }
  if (state === 'error' || !data) {
    return (
      <EmptyState
        icon="wifiOff"
        title="Could not load the facility directory"
        description="The network map and lists still work. Try again in a moment."
        action={<JivaButton size="sm" icon="refresh" onClick={onRetry}>Try again</JivaButton>}
      />
    );
  }

  const c = data.counts;
  const placed = (c.byCoordinateStatus.OSM_FACILITY_MATCH ?? 0) + (c.byCoordinateStatus.MANUAL_UNVERIFIED ?? 0);
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white p-3.5 text-[13px] ring-1 ring-ink-200">
        <p className="font-semibold text-ink-900">
          {c.total} listed facilities · {placed} on the map · {c.byCoordinateStatus.UNRESOLVED ?? 0} without a verified location
        </p>
        <p className="mt-1 text-ink-600">Public listings only. None is connected to JIVA: they receive no referrals, and their services, beds and capacity are unknown.</p>
        {data.osmSnapshot && (
          <p className="mt-1 text-xs text-ink-500">
            Locations: name-matched {data.osmSnapshot.attribution} (ODbL), snapshot {new Date(data.osmSnapshot.fetchedAt).toLocaleDateString()}.
          </p>
        )}
      </div>

      <label className="flex h-9 items-center gap-2 rounded-lg bg-white px-2.5 ring-1 ring-inset ring-ink-200 focus-within:ring-2 focus-within:ring-brand-500">
        <Icon name="search" size={15} className="text-ink-500" />
        <span className="sr-only">Search facilities</span>
        <input value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} placeholder="Search name, address or pincode" className="min-w-0 flex-1 bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400" />
      </label>
      <JivaFilter
        className="flex-wrap"
        label="Facility type"
        value={categories}
        onChange={(v) => { setCategories(v); setLimit(PAGE); }}
        options={CATEGORY_ORDER.filter((k) => c.byCategory[k]).map((k) => ({ value: k, label: facilityCategoryLabel(k), count: c.byCategory[k] }))}
      />
      <ToggleChip icon="pin" pressed={placedOnly} onChange={(v) => { setPlacedOnly(v); setLimit(PAGE); }}>Only facilities on the map</ToggleChip>

      {list.length === 0 ? (
        <EmptyState compact icon="filter" title="No listed facility matches" description="Try another name, or clear the filters." />
      ) : (
        <>
          <p className="text-xs text-ink-500">{list.length} shown{list.length > limit ? ` · first ${limit}` : ''}</p>
          <ul className="space-y-2">
            {list.slice(0, limit).map((f) => {
              const p = placement(f);
              const open = f.facilityId === selectedId;
              const hint = specialtyHintLabel(f.specialtyHint);
              return (
                <li key={f.facilityId}>
                  <button
                    type="button"
                    onClick={() => onSelect(f)}
                    aria-expanded={!f.location ? open : undefined}
                    className={cx('w-full rounded-xl bg-white p-3 text-left ring-1 ring-ink-200 transition-shadow hover:shadow-sm hover:ring-ink-300', open && 'ring-2 ring-brand-500')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink-900">{f.name}</p>
                        <p className="text-xs text-ink-600">{facilityCategoryLabel(f.category)}{hint ? ` · ${hint}` : ''}</p>
                        <p className="truncate text-xs text-ink-500">{f.address.fullAddress || 'Address not listed'}{f.address.pincode ? ` · ${f.address.pincode}` : ''}</p>
                      </div>
                      <JivaBadge tone={p.tone} icon={p.icon}>{p.label}</JivaBadge>
                    </div>
                  </button>
                  {open && !f.location && (
                    <div className="mt-1 rounded-xl bg-white p-3 ring-1 ring-ink-200">
                      <DirectoryFacilityDetails facility={f} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {list.length > limit && (
            <JivaButton size="sm" variant="ghost" icon="chevronDown" onClick={() => setLimit((l) => l + PAGE)}>
              Show more
            </JivaButton>
          )}
        </>
      )}
    </div>
  );
}
