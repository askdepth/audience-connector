import { describe, it, expect } from 'vitest';
import { sign, verify } from '../src/signing';

const secret = Buffer.from('connector-secret-abc123', 'utf8');
const otherSecret = Buffer.from('a-different-connector-secret', 'utf8');
const body = JSON.stringify({ criteria: { all: [] }, mapping: {} });
const TS = 1_700_000_000; // seconds

describe('sign', () => {
  it('is deterministic for the same body/timestamp/secret', () => {
    expect(sign(body, TS, secret)).toBe(sign(body, TS, secret));
  });

  it('prefixes the digest with "v1="', () => {
    expect(sign(body, TS, secret)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('changes when the body changes', () => {
    expect(sign(body, TS, secret)).not.toBe(sign(body + ' ', TS, secret));
  });

  it('changes when the timestamp changes', () => {
    expect(sign(body, TS, secret)).not.toBe(sign(body, TS + 1, secret));
  });

  it('changes when the secret changes', () => {
    expect(sign(body, TS, secret)).not.toBe(sign(body, TS, otherSecret));
  });
});

describe('verify — valid signature', () => {
  it('accepts a fresh, correctly signed request', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS + 10).valid).toBe(true);
  });
});

describe('verify — tampering', () => {
  it('rejects a payload that no longer matches the signature', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body + 'x', String(TS), sig, secret, TS)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a signature signed with a different secret', () => {
    const sig = sign(body, TS, otherSecret);
    expect(verify(body, String(TS), sig, secret, TS).valid).toBe(false);
  });

  it('rejects a same-length but altered signature via the length/compare path', () => {
    const sig = sign(body, TS, secret);
    const flipped = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
    expect(verify(body, String(TS), flipped, secret, TS)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a wrong-length signature without throwing (length check before timingSafeEqual)', () => {
    expect(() => verify(body, String(TS), 'v1=deadbeef', secret, TS)).not.toThrow();
    expect(verify(body, String(TS), 'v1=deadbeef', secret, TS)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });
});

describe('verify — timestamp / replay window (300s)', () => {
  it('rejects a non-numeric timestamp as malformed', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, 'not-a-number', sig, secret, TS)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('accepts a request just inside the window (now = ts + 299)', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS + 299).valid).toBe(true);
  });

  it('accepts a request exactly on the window boundary (now = ts + 300)', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS + 300).valid).toBe(true);
  });

  it('rejects a request just outside the window (now = ts + 301)', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS + 301)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects a clock-skewed request in the past direction (now = ts - 301)', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS - 301)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});

describe('verify — replay of an already-seen signature', () => {
  it('still verifies on a second use inside the window (nonce tracking is the caller’s job)', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS + 5).valid).toBe(true);
    expect(verify(body, String(TS), sig, secret, TS + 60).valid).toBe(true);
  });

  it('stops accepting the same signature once the window has passed', () => {
    const sig = sign(body, TS, secret);
    expect(verify(body, String(TS), sig, secret, TS + 100).valid).toBe(true);
    expect(verify(body, String(TS), sig, secret, TS + 400)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});
