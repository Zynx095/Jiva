import { useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  JivaButton,
  JivaCard,
  JivaStatus,
  NOTE_TYPES,
  NOTE_TYPE_TEXT,
  SkeletonRows,
  cx,
  formatDateTime,
  type ClinicalNoteRecord,
} from '@jiva/ui/src';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from './ui';

interface Draft {
  noteType: string;
  title: string;
  text: string;
}

const notesPath = (encounterId: string, noteId?: string) =>
  `/api/encounters/${encodeURIComponent(encounterId)}/notes${noteId ? `/${encodeURIComponent(noteId)}/amend` : ''}`;

/**
 * Clinical notes of one encounter: written by the assigned clinician for the care team, never shown to the
 * patient. Versioned like every record: a correction is a new version with a reason, the earlier text stays.
 */
export function NotesPanel({ encounterId, list, onChanged }: { encounterId: string; list: ClinicalNoteRecord[] | null | undefined; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <JivaCard>
      <CardHeader
        title="Clinical notes"
        icon="file"
        subtitle="Internal to the care team · never shown to the patient"
        actions={
          !creating && (
            <JivaButton size="sm" icon="plus" onClick={() => setCreating(true)}>
              New note
            </JivaButton>
          )
        }
      />
      {creating && (
        <NoteForm
          encounterId={encounterId}
          onSaved={() => {
            setCreating(false);
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setCreating(false)}
        />
      )}
      {list === undefined ? (
        <SkeletonRows rows={2} className="mt-3" />
      ) : list === null ? (
        <p className="mt-3 text-sm text-danger-700">Notes could not be loaded. They will be retried automatically.</p>
      ) : list.length === 0 ? (
        !creating && <p className="mt-3 text-sm text-ink-500">No notes for this encounter yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {list.map((n) => (
            <li key={n.noteId} className="py-3">
              <NoteItem note={n} encounterId={encounterId} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </JivaCard>
  );
}

function NoteItem({ note, encounterId, onChanged }: { note: ClinicalNoteRecord; encounterId: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const c = note.current;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-500">
            {NOTE_TYPE_TEXT[c.noteType] ?? c.noteType} · v{c.version} · {c.action === 'CREATED' ? 'written' : 'amended'} {formatDateTime(c.recordedAt)} by {c.author.displayName}
          </p>
          <p className="text-sm font-semibold text-ink-900">{c.title}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <JivaStatus meta={{ label: 'Care team only', tone: 'neutral', icon: 'shield' }} />
          {!editing && (
            <JivaButton size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Amend
            </JivaButton>
          )}
        </div>
      </div>
      {!editing && <p className="mt-1.5 whitespace-pre-line text-[13px] text-ink-800">{c.text}</p>}
      {editing && (
        <NoteForm
          encounterId={encounterId}
          base={note}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setEditing(false)}
        />
      )}
      {note.history.length > 1 && (
        <details className="mt-1.5 text-xs text-ink-600">
          <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">History ({note.history.length} versions)</summary>
          <ol className="mt-1.5 space-y-1.5">
            {[...note.history].reverse().map((v) => (
              <li key={v.version} className="rounded-lg bg-ink-25 px-2.5 py-1.5 ring-1 ring-inset ring-ink-100">
                <p className="font-semibold text-ink-800">
                  v{v.version} · {v.action.toLowerCase()} · {formatDateTime(v.recordedAt)} · {v.author.displayName}
                </p>
                <p className="whitespace-pre-line">{v.text}</p>
                {v.changeReason && <p className="text-ink-500">Reason: {v.changeReason}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function NoteForm({ encounterId, base, onSaved, onRefresh, onCancel }: { encounterId: string; base?: ClinicalNoteRecord; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => (base ? { noteType: base.current.noteType, title: base.current.title, text: base.current.text } : { noteType: 'PROGRESS', title: '', text: '' }));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const id = (k: string) => `note-${base?.noteId ?? 'new'}-${k}`;
  const ready = d.title.trim() && d.text.trim() && (!base || reason.trim());
  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-sm font-semibold text-ink-900">{base ? `Amend note (based on v${base.current.version})` : 'New clinical note'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind of note" htmlFor={id('type')} required>
          <select id={id('type')} className={cx(inputClass, 'h-9')} value={d.noteType} onChange={(e) => setD({ ...d, noteType: e.target.value })}>
            {NOTE_TYPES.map((t) => (
              <option key={t} value={t}>
                {NOTE_TYPE_TEXT[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" htmlFor={id('title')} required>
          <input id={id('title')} className={cx(inputClass, 'h-9')} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} maxLength={120} />
        </Field>
        <Field label="Note" htmlFor={id('text')} required className="sm:col-span-2">
          <textarea id={id('text')} className={cx(inputClass, 'min-h-28 py-2')} value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} maxLength={8000} />
        </Field>
        {base && (
          <Field label="Reason for the amendment" htmlFor={id('why')} required className="sm:col-span-2" hint="The earlier text stays in the history.">
            <input id={id('why')} className={cx(inputClass, 'h-9')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="primary"
          icon="check"
          disabled={!ready}
          pendingText="Saving…"
          onAction={async () => {
            const content = { noteType: d.noteType, title: d.title.trim(), text: d.text.trim() };
            const body = base ? { ...content, expectedVersion: base.current.version, changeReason: reason.trim() } : content;
            const r = await sendCommand(notesPath(encounterId, base?.noteId), { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onSaved();
            else if (r.status === 409) onRefresh();
            return r.error;
          }}
        >
          {base ? 'Save amendment' : 'Save note'}
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}
