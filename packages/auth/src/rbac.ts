import { AuthContext } from './types';

export class AccessControl {
  /**
   * Hospital users can only access their assigned hospital.
   * MANAGEMENT and ADMIN can access all hospitals.
   */
  static canAccessHospital(auth: AuthContext, targetHospitalId: string): boolean {
    if (auth.role === 'ADMIN' || auth.role === 'MANAGEMENT') {
      return true;
    }
    if (auth.role === 'HOSPITAL' && auth.hospitalId === targetHospitalId) {
      return true;
    }
    return false;
  }

  /**
   * Ambulance users can only access their assigned ambulance.
   * MANAGEMENT and ADMIN can access all ambulances.
   */
  static canAccessAmbulance(auth: AuthContext, targetAmbulanceId: string): boolean {
    if (auth.role === 'ADMIN' || auth.role === 'MANAGEMENT') {
      return true;
    }
    if (auth.role === 'AMBULANCE' && auth.ambulanceId === targetAmbulanceId) {
      return true;
    }
    return false;
  }

  /**
   * Patients can only access their own case.
   * MANAGEMENT and ADMIN can view cases.
   * Assigned ambulances and destination hospitals can view the patient case.
   */
  static canAccessPatient(auth: AuthContext, targetCaseId: string, isOperationallyRelated = false): boolean {
    if (auth.role === 'ADMIN' || auth.role === 'MANAGEMENT') {
      return true;
    }
    if (auth.role === 'PATIENT' && auth.caseId === targetCaseId) {
      return true;
    }
    // Clinicians/EMS may view a case only when they are operationally involved
    // (assigned ambulance, or a hospital that received an acceptance request / is the destination).
    if ((auth.role === 'HOSPITAL' || auth.role === 'AMBULANCE') && isOperationallyRelated) {
      return true;
    }
    return false;
  }

  /**
   * Only MANAGEMENT and ADMIN can access the network-wide command center.
   */
  static canAccessManagement(auth: AuthContext): boolean {
    return auth.role === 'ADMIN' || auth.role === 'MANAGEMENT';
  }

  /**
   * Only ADMIN can perform destructive or administrative operations.
   */
  static canPerformAdmin(auth: AuthContext): boolean {
    return auth.role === 'ADMIN';
  }
}
