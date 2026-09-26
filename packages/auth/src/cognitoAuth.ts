import { AuthContext, AuthResult, UserRole } from './types';

export interface CognitoClaims {
  sub: string;
  email?: string;
  'cognito:groups'?: string[];
  'custom:hospitalId'?: string;
  'custom:ambulanceId'?: string;
  'custom:caseId'?: string;
  exp?: number;
}

export class CognitoAuthProvider {
  /**
   * Decodes and validates Cognito JWT claims.
   * In a Lambda Authorizer or API Gateway, claims are injected into event.requestContext.authorizer.claims
   */
  static parseClaims(claims: CognitoClaims): AuthResult {
    if (!claims || !claims.sub) {
      return { authenticated: false, error: 'Missing subject claim in Cognito token' };
    }

    const groups = claims['cognito:groups'] || [];
    let role: UserRole = 'PATIENT';

    if (groups.includes('ADMIN')) {
      role = 'ADMIN';
    } else if (groups.includes('MANAGEMENT')) {
      role = 'MANAGEMENT';
    } else if (groups.includes('HOSPITAL')) {
      role = 'HOSPITAL';
    } else if (groups.includes('AMBULANCE')) {
      role = 'AMBULANCE';
    } else if (groups.includes('PATIENT')) {
      role = 'PATIENT';
    }

    const context: AuthContext = {
      userId: claims.sub,
      role,
      email: claims.email,
      hospitalId: claims['custom:hospitalId'],
      ambulanceId: claims['custom:ambulanceId'],
      caseId: claims['custom:caseId'],
      isDemo: false,
    };

    return { authenticated: true, context };
  }
}
