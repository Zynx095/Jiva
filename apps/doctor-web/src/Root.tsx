import { useEffect, useState } from 'react';
import { EmptyState, JivaButton, JivaCard, JivaLogo, JivaSkeleton, jivaAppUrl } from '@jiva/ui/src';
import { apiGet, PERSONA } from './api';
import { DoctorWorkspace } from './DoctorWorkspace';

/**
 * The doctor workspace serves clinicians only (the role comes from the server). Anyone else is pointed to
 * their own interface; nothing clinical is requested for them.
 */
export default function Root() {
  const [role, setRole] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      apiGet<{ role?: string }>('/api/whoami')
        .then((me) => live && setRole(me.role ?? 'UNKNOWN'))
        .catch(() => {
          if (!live) return;
          setFailed(true);
          window.setTimeout(load, 3000);
        });
    void load();
    return () => {
      live = false;
    };
  }, []);

  if (role === 'CLINICIAN') return <DoctorWorkspace />;
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <JivaLogo className="mb-6" />
      {role ? (
        <JivaCard>
          <EmptyState
            icon="stethoscope"
            title="This is the doctor workspace"
            description={`It is for clinicians assigned to patients. The persona "${PERSONA}" is not a clinician.`}
          />
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {role === 'HOSPITAL' && (
              <JivaButton icon="hospital" onClick={() => window.location.assign(jivaAppUrl('hospital', PERSONA))}>
                Open the hospital console
              </JivaButton>
            )}
            <JivaButton variant="ghost" icon="user" onClick={() => window.location.assign(jivaAppUrl('doctor', 'demo-doc-3'))}>
              Continue as a demo clinician
            </JivaButton>
          </div>
        </JivaCard>
      ) : failed ? (
        <EmptyState icon="wifiOff" title="Cannot reach JIVA" description="Retrying automatically. Check that the JIVA API is running." />
      ) : (
        <div className="space-y-3">
          <JivaSkeleton className="h-6 w-2/3" />
          <JivaSkeleton className="h-4 w-1/2" />
        </div>
      )}
    </div>
  );
}
