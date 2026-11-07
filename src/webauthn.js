// Passkey (WebAuthn Level 2) verification on Node's own crypto: no dependency.
// Registration asks for attestation "none", so only the authenticator data and the public key are read; sign-in
// checks the signature over authenticatorData || SHA-256(clientDataJSON). Both always require user presence and
// user verification (Face ID, fingerprint or the device PIN), and that the browser was on our origin.
// Spec: https://www.w3.org/TR/webauthn-2/ (§7.1 registration, §7.2 assertion, §6.1 authenticator data).
import crypto from 'node:crypto';

export const ALG_ES256 = -7, ALG_RS256 = -257, ALG_EDDSA = -8;
export const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = (s, what) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length > 20000) throw new Error(`${what} is not base64url`);
  return Buffer.from(s, 'base64url');
};
const sha256 = buf => crypto.createHash('sha256').update(buf).digest();

// Minimal CBOR (RFC 8949) decoder: unsigned/negative integers, byte and text strings, arrays, maps, simple
// values. That is everything an attestation object and a COSE key use. Returns [value, nextOffset].
export function cborDecode(buf, offset = 0, depth = 0) {
  if (depth > 16) throw new Error('CBOR nested too deeply');
  if (offset >= buf.length) throw new Error('CBOR ends early');
  const first = buf[offset], major = first >> 5, info = first & 31;
  let pos = offset + 1, len;
  if (info < 24) len = info;
  else if (info === 24) { len = buf[pos]; pos += 1; }
  else if (info === 25) { len = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { len = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { const big = buf.readBigUInt64BE(pos); pos += 8; if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR number too large'); len = Number(big); }
  else throw new Error('CBOR indefinite lengths are not supported');
  if (pos > buf.length) throw new Error('CBOR ends early');
  switch (major) {
    case 0: return [len, pos];
    case 1: return [-1 - len, pos];
    case 2: if (pos + len > buf.length) throw new Error('CBOR ends early'); return [buf.subarray(pos, pos + len), pos + len];
    case 3: if (pos + len > buf.length) throw new Error('CBOR ends early'); return [buf.subarray(pos, pos + len).toString('utf8'), pos + len];
    case 4: { if (len > 1000) throw new Error('CBOR array too long'); const out = []; for (let i = 0; i < len; i++) { const [v, p] = cborDecode(buf, pos, depth + 1); out.push(v); pos = p; } return [out, pos]; }
    case 5: { if (len > 1000) throw new Error('CBOR map too long'); const out = new Map(); for (let i = 0; i < len; i++) { const [k, p1] = cborDecode(buf, pos, depth + 1); const [v, p2] = cborDecode(buf, p1, depth + 1); out.set(k, v); pos = p2; } return [out, pos]; }
    case 7: if (info === 20) return [false, pos]; if (info === 21) return [true, pos]; if (info === 22) return [null, pos]; throw new Error('CBOR value not supported');
    default: throw new Error('CBOR tags are not supported');
  }
}

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
export function parseAuthenticatorData(buf) {
  if (buf.length < 37) throw new Error('Authenticator data is too short');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) throw new Error('Authenticator data is missing the credential');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || 55 + idLen > buf.length) throw new Error('Credential id has a bad length');
    out.credentialId = buf.subarray(55, 55 + idLen);
    const [cose, end] = cborDecode(buf, 55 + idLen);
    out.cose = cose;
    out.coseBytesEnd = end;
  }
  return out;
}

// A COSE public key (RFC 9053) as a Node KeyObject, and the algorithm it signs with.
export function coseToKey(cose) {
  if (!(cose instanceof Map)) throw new Error('Public key is not a COSE map');
  const kty = cose.get(1), alg = cose.get(3);
  const bytes = label => { const v = cose.get(label); if (!Buffer.isBuffer(v)) throw new Error('Public key is incomplete'); return b64u(v); };
  if (kty === 2 && alg === ALG_ES256 && cose.get(-1) === 1) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } }) };
  if (kty === 3 && alg === ALG_RS256) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: bytes(-1), e: bytes(-2) } }) };
  if (kty === 1 && alg === ALG_EDDSA && cose.get(-1) === 6) return { alg, key: crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) } }) };
  throw new Error('This passkey uses an algorithm Quiet Chapters does not accept');
}

function checkClientData(clientDataB64, type, expected) {
  const raw = fromB64u(clientDataB64, 'clientDataJSON');
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new Error('clientDataJSON is not JSON'); }
  if (data.type !== type) throw new Error('Wrong WebAuthn ceremony');
  if (data.challenge !== expected.challenge) throw new Error('The challenge does not match');
  if (data.origin !== expected.origin) throw new Error('The passkey was used on another site');
  if (data.crossOrigin === true) throw new Error('Cross-origin passkey use is not allowed');
  return raw;
}

function checkAuthData(auth, rpId) {
  if (!crypto.timingSafeEqual(auth.rpIdHash, sha256(Buffer.from(rpId)))) throw new Error('The passkey belongs to another site');
  if (!(auth.flags & FLAG_UP)) throw new Error('The user was not present');
  if (!(auth.flags & FLAG_UV)) throw new Error('Face ID, fingerprint or the device PIN is required');
}

// expected: { challenge, origin, rpId }. Returns what to store for the new passkey.
export function verifyRegistration(credential, expected) {
  const r = credential?.response || {};
  checkClientData(r.clientDataJSON, 'webauthn.create', expected);
  const [att] = cborDecode(fromB64u(r.attestationObject, 'attestationObject'));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('Attestation object is malformed');
  const auth = parseAuthenticatorData(att.get('authData'));
  checkAuthData(auth, expected.rpId);
  if (!auth.credentialId) throw new Error('No credential was created');
  if (credential.id && credential.id !== b64u(auth.credentialId)) throw new Error('Credential id does not match');
  const { alg, key } = coseToKey(auth.cose);
  return {
    credentialId: b64u(auth.credentialId), alg, signCount: auth.signCount,
    publicKey: key.export({ format: 'pem', type: 'spki' }),
    backedUp: !!(auth.flags & 0x10),
  };
}

// expected: { challenge, origin, rpId, publicKey (SPKI PEM), alg, signCount }. Returns the new sign count.
export function verifyAssertion(credential, expected) {
  const r = credential?.response || {};
  const clientData = checkClientData(r.clientDataJSON, 'webauthn.get', expected);
  const authBytes = fromB64u(r.authenticatorData, 'authenticatorData');
  const auth = parseAuthenticatorData(authBytes);
  checkAuthData(auth, expected.rpId);
  const signed = Buffer.concat([authBytes, sha256(clientData)]);
  const signature = fromB64u(r.signature, 'signature');
  const key = crypto.createPublicKey(expected.publicKey);
  const ok = expected.alg === ALG_EDDSA ? crypto.verify(null, signed, key, signature)
    : expected.alg === ALG_ES256 ? crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, signature)
    : expected.alg === ALG_RS256 ? crypto.verify('sha256', signed, key, signature)
    : false;
  if (!ok) throw new Error('The passkey signature is not valid');
  // A counter that stops increasing means the passkey may have been copied (§6.1.1). Synced passkeys report 0.
  if ((auth.signCount || expected.signCount) && auth.signCount <= expected.signCount) throw new Error('This passkey looks cloned');
  return { signCount: auth.signCount };
}
