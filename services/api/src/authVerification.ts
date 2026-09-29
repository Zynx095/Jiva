import { AuthContext, JwtVerifier, JwksProvider, StaticJwksProvider, DemoAuthProvider } from '@jiva/auth';
import { loadConfig } from '@jiva/config';
import { evidenceEnvironment } from './evidenceTrust';

const config = loadConfig();

let customJwksProvider: JwksProvider | undefined;
let customVerifier: JwtVerifier | undefined;

export function setCustomJwksProvider(provider: JwksProvider | undefined): void {
  customJwksProvider = provider;
  customVerifier = undefined;
}

export function setCustomVerifier(verifier: JwtVerifier | undefined): void {
  customVerifier = verifier;
}

export class CognitoJwksProvider implements JwksProvider {
  private jwksUrl: string;
  private cachedKeys = new Map<string, string>();
  private lastFetched = 0;

  constructor(region: string, userPoolId: string) {
    this.jwksUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
  }

  async getKey(kid: string): Promise<string | undefined> {
    if (this.cachedKeys.has(kid) && Date.now() - this.lastFetched < 3600_000) {
      return this.cachedKeys.get(kid);
    }
    try {
      const res = await fetch(this.jwksUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { keys?: Array<{ kid: string; n: string; e: string }> };
      if (Array.isArray(data.keys)) {
        for (const k of data.keys) {
          // Store raw or convert if needed
          if (k.kid) this.cachedKeys.set(k.kid, k.n);
        }
      }
      this.lastFetched = Date.now();
    } catch (err) {
      console.warn(`[CognitoJwksProvider] Failed to fetch JWKS from ${this.jwksUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.cachedKeys.get(kid);
  }
}

export function getJwtVerifier(): JwtVerifier {
  if (customVerifier) return customVerifier;

  const region = config.aws.region || 'ap-south-1';
  const userPoolId = config.aws.cognitoUserPoolId || 'ap-south-1_DEMO';
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const audience = config.aws.cognitoClientId;

  const jwksProvider = customJwksProvider || new CognitoJwksProvider(region, userPoolId);

  return new JwtVerifier({
    issuer,
    audience,
    jwksProvider,
    clockToleranceSeconds: 5,
  });
}

/**
 * PRODUCTION & STANDALONE AUTHENTICATION BOUNDARY
 *
 * 1. Cryptographic JWT Verification:
 *    If an Authorization: Bearer <token> header is provided, it is verified cryptographically:
 *    - RS256 signature against trusted JWKS
 *    - Issuer matches Cognito user pool
 *    - Audience matches client ID (if configured)
 *    - Expiration & not-before timestamps
 *    - Valid Cognito claims mapped to AuthContext
 *
 * 2. Unverified Claims Rejection:
 *    Raw `x-cognito-claims` headers without cryptographic signature are explicitly REFUSED.
 *    No client can forge identity or bypass RBAC by supplying arbitrary decoded JSON claims.
 *
 * 3. Environment Protection:
 *    If configured as PRODUCTION (evidenceEnvironment() === 'PRODUCTION'), unsigned demo
 *    persona headers (x-jiva-demo-*) are unconditionally rejected.
 *
 * 4. Local Demo Fallback:
 *    In DEMO environment only, DemoAuthProvider resolves development personas.
 */
export async function authenticateRequest(
  headers: Record<string, string | string[] | undefined>
): Promise<AuthContext | undefined> {
  const authHeader = headers['authorization'];
  const rawAuth = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  // 1. Bearer token path (verified cryptographically)
  if (typeof rawAuth === 'string' && rawAuth.startsWith('Bearer ')) {
    const token = rawAuth.substring(7).trim();
    if (token) {
      const verifier = getJwtVerifier();
      const result = await verifier.verify(token);
      if (result.authenticated && result.context) {
        return result.context;
      }
      // Invalid token supplied in Authorization header: do not fall through to demo auth
      console.warn(`[Auth] JWT verification failed: ${result.error}`);
      return undefined;
    }
  }

  // 2. Reject untrusted, unsigned claims header
  if (headers['x-cognito-claims']) {
    console.warn('[Auth] Rejected unverified x-cognito-claims header; cryptographic JWT required.');
    return undefined;
  }

  // 3. Reject demo personas in production
  if (evidenceEnvironment() === 'PRODUCTION') {
    return undefined;
  }

  // 4. Local demo mode persona resolution
  const demo = DemoAuthProvider.authenticate(headers);
  return demo.authenticated ? demo.context : undefined;
}
