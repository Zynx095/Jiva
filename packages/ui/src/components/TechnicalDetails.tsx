import React from 'react';
import { cx } from '../lib/cx';
import type { JivaEvent } from '../lib/events';
import { formatClockSeconds } from '../lib/time';
import { Icon } from './Icon';

export interface TechnicalDetailsProps {
  fields?: Array<[string, React.ReactNode]>;
  /** Raw object shown as JSON (payloads, traces). */
  data?: unknown;
  summary?: string;
  className?: string;
}

/**
 * Level-4 disclosure: identifiers, provenance and raw payloads for audit and engineering.
 * Collapsed by default so everyday users never have to read hashes or ids.
 */
export function TechnicalDetails({ fields, data, summary = 'Technical details', className }: TechnicalDetailsProps) {
  return (
    <details className={cx('group rounded-lg', className)}>
      <summary className="inline-flex items-center gap-1 rounded text-xs font-semibold text-ink-600 hover:text-ink-900">
        <Icon name="code" size={13} />
        {summary}
        <Icon name="chevronDown" size={13} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-2">
        {fields && fields.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {fields.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-ink-500">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-ink-800">{v ?? '—'}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        {data !== undefined && (
          <pre className="jiva-scroll max-h-60 overflow-auto rounded-md bg-ink-900 p-2.5 font-mono text-[11px] leading-4 text-ink-100">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

/** Standard audit fields for an event. */
export function eventTechnicalFields(e: JivaEvent): Array<[string, React.ReactNode]> {
  const trusted = (e.metadata?.trustedEvidence ?? undefined) as { status?: string; environment?: string } | undefined;
  const p = e.payload as { snapshot?: { snapshotHash?: string }; auditHash?: string; policy?: { hash?: string; version?: string } };
  return [
    ['Event type', e.eventType],
    ['Event id', e.eventId],
    ['Source', `${e.source.type}:${e.source.id}`],
    ['Time', formatClockSeconds(e.timestamp)],
    ['Correlation id', e.correlationId],
    ['Caused by', e.causationId],
    ['Evidence', trusted?.status ? `${trusted.status} (${trusted.environment ?? 'unknown env'})` : undefined],
    ['Snapshot hash', p.snapshot?.snapshotHash],
    ['Audit hash', p.auditHash],
    ['Policy', p.policy?.hash ? `${p.policy.version ?? ''} ${p.policy.hash}`.trim() : undefined],
  ].filter(([, v]) => v !== undefined) as Array<[string, React.ReactNode]>;
}
