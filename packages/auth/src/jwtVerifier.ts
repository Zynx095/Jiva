import crypto from 'crypto';
import { AuthContext, AuthResult, UserRole } from './types';
import { CognitoAuthProvider, CognitoClaims } from './cognitoAuth';

export interface JwksKey {
  kid: string;
  alg: string;
  kty: string;
  use?: string;
  n?: string;
  e?: string;
  publicKeyPem?: string;
}

export interface JwksProvider {
  getKey(kid: string): Promise<string | undefined>;
}

export interface JwtVerifierOptions {
  issuer: string;
  audience?: string;
  jwksProvider: JwksProvider;
  clockToleranceSeconds?: number;
}

export interface RawJwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface RawJwtPayload extends CognitoClaims {
  iss?: string;
  aud?: string | string[];
  client_id?: string;
  nbf?: number;
  iat?: number;
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

function base64UrlToBuffer(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

export class JwtVerifier {
  constructor(private readonly options: JwtVerifierOptions) {}

  async verify(token: string): Promise<AuthResult> {
    if (!token || typeof token !== 'string') {
      return { authenticated: false, error: 'Token is missing or not a string' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return { authenticated: false, error: 'Malformed JWT: must contain exactly 3 segments' };
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    let header: RawJwtHeader;
    let payload: RawJwtPayload;

    try {
      header = JSON.parse(base64UrlDecode(headerB64));
    } catch {
      return { authenticated: false, error: 'Malformed JWT header: invalid JSON' };
    }

    try {
      payload = JSON.parse(base64UrlDecode(payloadB64));
    } catch {
      return { authenticated: false, error: 'Malformed JWT payload: invalid JSON' };
    }

    // 1. Algorithm check: RS256 strictly required for Cognito ID/Access tokens
    if (header.alg !== 'RS256') {
      return { authenticated: false, error: `Unsupported JWT algorithm: ${header.alg}. Only RS256 is permitted.` };
    }

    if (!header.kid) {
      return { authenticated: false, error: 'Missing key ID (kid) in JWT header' };
    }

    // 2. Fetch public key from JWKS
    let publicKeyPem: string | undefined;
    try {
      publicKeyPem = await this.options.jwksProvider.getKey(header.kid);
    } catch (err) {
      return { authenticated: false, error: `JWKS retrieval failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!publicKeyPem) {
      return { authenticated: false, error: `Unknown key ID in JWT header: ${header.kid}` };
    }

    // 3. Cryptographic signature verification
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = base64UrlToBuffer(signatureB64);

    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signedData);
      const valid = verifier.verify(publicKeyPem, signature);
      if (!valid) {
        return { authenticated: false, error: 'Invalid JWT signature' };
      }
    } catch (err) {
      return { authenticated: false, error: `Signature verification failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const tolerance = this.options.clockToleranceSeconds ?? 5;

    // 4. Issuer check
    if (!payload.iss || payload.iss !== this.options.issuer) {
      return { authenticated: false, error: `JWT issuer mismatch: expected ${this.options.issuer}, got ${payload.iss}` };
    }

    // 5. Audience check (if configured)
    if (this.options.audience) {
      const audMatches = Array.isArray(payload.aud)
        ? payload.aud.includes(this.options.audience)
        : payload.aud === this.options.audience;
      const clientMatches = payload.client_id === this.options.audience;

      if (!audMatches && !clientMatches) {
        return { authenticated: false, error: `JWT audience mismatch: expected ${this.options.audience}` };
      }
    }

    // 6. Expiry check
    if (typeof payload.exp !== 'number' || payload.exp <= (nowSec - tolerance)) {
      return { authenticated: false, error: 'JWT token has expired' };
    }

    // 7. Not before check (if present)
    if (typeof payload.nbf === 'number' && payload.nbf > (nowSec + tolerance)) {
      return { authenticated: false, error: 'JWT token is not yet valid' };
    }

    // 8. Subject claim requirement
    if (!payload.sub || typeof payload.sub !== 'string') {
      return { authenticated: false, error: 'Missing subject (sub) claim in JWT' };
    }

    // 9. Delegate role & scope parsing to CognitoAuthProvider
    return CognitoAuthProvider.parseClaims(payload);
  }
}

/** In-memory JWKS provider for local testing and deterministic mocking. */
export class StaticJwksProvider implements JwksProvider {
  private keys = new Map<string, string>();

  constructor(initialKeys: Record<string, string> = {}) {
    for (const [kid, pem] of Object.entries(initialKeys)) {
      this.keys.set(kid, pem);
    }
  }

  addKey(kid: string, publicKeyPem: string): void {
    this.keys.set(kid, publicKeyPem);
  }

  removeKey(kid: string): void {
    this.keys.delete(kid);
  }

  async getKey(kid: string): Promise<string | undefined> {
    return this.keys.get(kid);
  }
}

/** Test utility: generate RSA keypair and sign test tokens */
export function generateTestRsaKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function signTestJwt(
  payload: Record<string, unknown>,
  privateKeyPem: string,
  options: { kid: string; alg?: string }
): string {
  const header = { alg: options.alg || 'RS256', typ: 'JWT', kid: options.kid };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${headerB64}.${payloadB64}`);
  const signatureB64 = signer.sign(privateKeyPem).toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
