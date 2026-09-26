import { AccessControl, DEMO_USERS, AuthContext } from '@jiva/auth';

function testRbac() {
  console.log('[Test] Running RBAC Security Verification...');

  const mgmtUser = DEMO_USERS['demo-mgmt-1'];
  const hosp1User = DEMO_USERS['demo-hosp-1'];
  const amb1User = DEMO_USERS['demo-amb-1'];
  const patientUser = DEMO_USERS['demo-patient-1'];

  // 1. Management access
  if (!AccessControl.canAccessManagement(mgmtUser)) {
    throw new Error('Management user must have access to management view');
  }
  if (AccessControl.canAccessManagement(hosp1User)) {
    throw new Error('Hospital user must NOT have access to management command center');
  }
  if (AccessControl.canAccessManagement(patientUser)) {
    throw new Error('Patient user must NOT have access to management command center');
  }

  // 2. Hospital Scoping
  if (!AccessControl.canAccessHospital(hosp1User, 'HOSP-BLR-001')) {
    throw new Error('Hospital 1 user should access HOSP-BLR-001');
  }
  if (AccessControl.canAccessHospital(hosp1User, 'HOSP-BLR-002')) {
    throw new Error('Hospital 1 user must NOT access HOSP-BLR-002');
  }
  if (!AccessControl.canAccessHospital(mgmtUser, 'HOSP-BLR-002')) {
    throw new Error('Management user should be able to view any hospital');
  }

  // 3. Ambulance Scoping
  if (!AccessControl.canAccessAmbulance(amb1User, 'AMB-BLR-001')) {
    throw new Error('Ambulance 1 user should access AMB-BLR-001');
  }
  if (AccessControl.canAccessAmbulance(amb1User, 'AMB-BLR-002')) {
    throw new Error('Ambulance 1 user must NOT access AMB-BLR-002');
  }

  // 4. Patient Privacy Scoping
  if (!AccessControl.canAccessPatient(patientUser, 'CASE-BLR-876')) {
    throw new Error('Patient should access their own case CASE-BLR-876');
  }
  if (AccessControl.canAccessPatient(patientUser, 'CASE-BLR-999')) {
    throw new Error('Patient must NOT access other patients cases!');
  }

  console.log('✓ RBAC security test passed: scoped hospital, ambulance, patient, and management access enforced.\n');
}

try {
  testRbac();
} catch (err) {
  console.error('✗ RBAC test failed:', err);
  process.exit(1);
}
