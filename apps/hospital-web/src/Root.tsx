import { useEffect, useState } from 'react';
import { EmptyState, JivaButton, JivaCard, JivaLogo, JivaSkeleton, jivaAppUrl } from '@jiva/ui/src';
import App from './App';
import { apiGet, PERSONA } from './api';

/**
 * The hospital console serves coordination staff (arrivals, handovers, doctor assignment, referral
 * answers). Clinicians have their own interface, the doctor workspace; the role comes from the server.
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

  if (role === 'CLINICIAN') {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <JivaLogo className="mb-6" />
        <JivaCard>
          <EmptyState icon="stethoscope" title="Clinicians use the doctor workspace" description="This is the hospital coordination console. Your assigned patients and their records are in the doctor workspace." />
          <div className="mt-3 flex justify-center">
            <JivaButton variant="primary" icon="arrowRight" onClick={() => window.location.assign(jivaAppUrl('doctor', PERSONA))}>
              Open the doctor workspace
            </JivaButton>
          </div>
        </JivaCard>
      </div>
    );
  }
  if (role) return <App />;
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      {failed ? (
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
