export type UserRole = 'PATIENT' | 'AMBULANCE' | 'HOSPITAL' | 'MANAGEMENT' | 'ADMIN';

export interface AuthContext {
  userId: string;
  role: UserRole;
  email?: string;
  hospitalId?: string;    // Scoped hospital for HOSPITAL role
  ambulanceId?: string;   // Scoped ambulance for AMBULANCE role
  caseId?: string;        // Scoped case for PATIENT role
  isDemo?: boolean;
}

export interface AuthResult {
  authenticated: boolean;
  context?: AuthContext;
  error?: string;
}
