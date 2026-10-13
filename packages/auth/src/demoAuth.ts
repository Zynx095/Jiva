import { AuthContext, AuthResult } from './types';

/**
 * DEMO-ONLY AUTHENTICATION.
 *
 * This is NOT production authentication. It exists so the local hackathon demo
 * can exercise server-side RBAC without an identity provider. A request selects
 * one of the fixed personas below by id; the server then enforces that persona's
 * role and scope. Unknown ids, missing credentials and free-form role headers are
 * rejected (there is no default role). Production uses Cognito (see cognitoAuth.ts).
 *
 * Credential forms accepted:
 *   - header  `x-jiva-demo-user: <personaId>`
 *   - header  `Authorization: Bearer demo:<personaId>`
 *   - Socket.IO handshake `auth: { demoUser: '<personaId>' }`
 */
export const DEMO_USERS: Record<string, AuthContext> = {
  'demo-mgmt-1': { userId: 'demo-mgmt-1', role: 'MANAGEMENT', email: 'ops-director@jiva.demo', isDemo: true },
  'demo-admin': { userId: 'demo-admin', role: 'ADMIN', email: 'admin@jiva.demo', isDemo: true },
  'demo-hosp-1': { userId: 'demo-hosp-1', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-001', isDemo: true },
  'demo-hosp-2': { userId: 'demo-hosp-2', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-002', isDemo: true },
  'demo-hosp-3': { userId: 'demo-hosp-3', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-003', isDemo: true },
  'demo-hosp-4': { userId: 'demo-hosp-4', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-004', isDemo: true },
  // Synthetic clinicians (see data/synthetic/bengaluru/clinicians.json). Two at HOSP-BLR-004 so that
  // "a doctor at the same hospital who is NOT assigned" can be exercised.
  'demo-doc-1': { userId: 'demo-doc-1', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-004', practitionerId: 'PRAC-BLR-004-01', isDemo: true },
  'demo-doc-2': { userId: 'demo-doc-2', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-004', practitionerId: 'PRAC-BLR-004-02', isDemo: true },
  'demo-doc-3': { userId: 'demo-doc-3', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-001', practitionerId: 'PRAC-BLR-001-01', isDemo: true },
  'demo-doc-4': { userId: 'demo-doc-4', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-002', practitionerId: 'PRAC-BLR-002-01', isDemo: true },
  'demo-doc-5': { userId: 'demo-doc-5', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-003', practitionerId: 'PRAC-BLR-003-01', isDemo: true },
  'demo-amb-1': { userId: 'demo-amb-1', role: 'AMBULANCE', ambulanceId: 'AMB-BLR-001', isDemo: true },
  'demo-amb-2': { userId: 'demo-amb-2', role: 'AMBULANCE', ambulanceId: 'AMB-BLR-002', isDemo: true },
  'demo-amb-3': { userId: 'demo-amb-3', role: 'AMBULANCE', ambulanceId: 'AMB-BLR-003', isDemo: true },
  'demo-patient-1': { userId: 'demo-patient-1', role: 'PATIENT', caseId: 'CASE-BLR-876', isDemo: true },
  'demo-patient-2': { userId: 'demo-patient-2', role: 'PATIENT', caseId: 'CASE-BLR-877', isDemo: true },
};

export class DemoAuthProvider {
  static resolvePersona(personaId: unknown): AuthResult {
    if (typeof personaId === 'string' && Object.prototype.hasOwnProperty.call(DEMO_USERS, personaId)) {
      return { authenticated: true, context: DEMO_USERS[personaId] };
    }
    return { authenticated: false, error: personaId ? 'Unknown demo persona' : 'Missing credentials' };
  }

  static authenticate(headers: Record<string, string | string[] | undefined>): AuthResult {
    const direct = headers['x-jiva-demo-user'];
    if (typeof direct === 'string') return DemoAuthProvider.resolvePersona(direct);

    const authz = headers['authorization'];
    if (typeof authz === 'string' && authz.startsWith('Bearer demo:')) {
      return DemoAuthProvider.resolvePersona(authz.slice('Bearer demo:'.length).trim());
    }
    return { authenticated: false, error: 'Missing credentials' };
  }
}
