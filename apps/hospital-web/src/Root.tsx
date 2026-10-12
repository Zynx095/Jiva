import { useEffect, useState } from 'react';
import { EmptyState, JivaSkeleton } from '@jiva/ui/src';
import App from './App';
import { apiGet } from './api';
import { ClinicianWorkspace } from './clinician/ClinicianWorkspace';

/**
 * One hospital app, two roles: coordination staff (arrivals, handovers, doctor assignment, referral
 * answers) and clinicians (their assigned patients' records). The role comes from the server.
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

  if (role === 'CLINICIAN') return <ClinicianWorkspace />;
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
