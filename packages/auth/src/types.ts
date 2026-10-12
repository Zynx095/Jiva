/**
 * HOSPITAL  — hospital coordination staff (acceptance answers, capacity, arrivals, handover, doctor assignment).
 * CLINICIAN — a doctor at one hospital: clinical documentation for the encounters assigned to them only.
 */
export type UserRole = 'PATIENT' | 'AMBULANCE' | 'HOSPITAL' | 'CLINICIAN' | 'MANAGEMENT' | 'ADMIN';

export interface AuthContext {
  userId: string;
  role: UserRole;
  email?: string;
  hospitalId?: string;    // Scoped hospital for HOSPITAL and CLINICIAN roles
  ambulanceId?: string;   // Scoped ambulance for AMBULANCE role
  caseId?: string;        // Scoped case for PATIENT role
  practitionerId?: string; // Scoped practitioner (staff record) for CLINICIAN role
  isDemo?: boolean;
}

export interface AuthResult {
  authenticated: boolean;
  context?: AuthContext;
  error?: string;
}
