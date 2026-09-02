import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION, computeSupportedUntil, type ContractVersionInfo } from '../src/version';

describe('CONTRACT_VERSION — wire protocol version', () => {
  it('is the frozen v1 semver string', () => {
    expect(CONTRACT_VERSION).toBe('1.0.0');
  });

  it('is a plain semver, parseable for negotiation', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('computeSupportedUntil — D10 12-month window', () => {
  it('adds 365 days to a non-leap-year release date', () => {
    // 2027 is not a leap year: 2027-01-01 + 365d = 2028-01-01
    expect(computeSupportedUntil('2027-01-01T00:00:00.000Z')).toBe('2028-01-01T00:00:00.000Z');
  });

  it('adds 365 calendar days (not one calendar year) across a leap day', () => {
    // 2028 is a leap year: 2028-01-01 + 365d lands on 2028-12-31, one day short
    // of a calendar year because 29 Feb sits inside the span.
    expect(computeSupportedUntil('2028-01-01T00:00:00.000Z')).toBe('2028-12-31T00:00:00.000Z');
  });

  it('preserves the time-of-day of the release instant', () => {
    expect(computeSupportedUntil('2027-06-15T12:34:56.000Z')).toBe('2028-06-14T12:34:56.000Z');
  });

  it('returns a canonical ISO-8601 string', () => {
    const out = computeSupportedUntil('2027-03-09T08:00:00.000Z');
    expect(new Date(out).toISOString()).toBe(out);
  });
});

describe('support-window boundary (consumer semantics, exercised here)', () => {
  const v2ReleasedAt = '2027-01-01T00:00:00.000Z';
  const supportedUntil = computeSupportedUntil(v2ReleasedAt);
  const cutoff = new Date(supportedUntil).getTime();

  const stillSupported = (nowMs: number) => nowMs <= cutoff;

  it('a v1 connector is supported just before the sunset instant', () => {
    expect(stillSupported(cutoff - 1)).toBe(true);
  });

  it('a v1 connector is supported exactly at the sunset instant (inclusive)', () => {
    expect(stillSupported(cutoff)).toBe(true);
  });

  it('a v1 connector is out of support just after the sunset instant', () => {
    expect(stillSupported(cutoff + 1)).toBe(false);
  });
});

describe('ContractVersionInfo shape', () => {
  it('models the current major with a null supportedUntil', () => {
    const current: ContractVersionInfo = {
      version: '1.0.0',
      releasedAt: '2026-09-01T00:00:00.000Z',
      supportedUntil: null,
    };
    expect(current.supportedUntil).toBeNull();
  });

  it('models a superseded major with a concrete sunset date', () => {
    const superseded: ContractVersionInfo = {
      version: '1.0.0',
      releasedAt: '2026-09-01T00:00:00.000Z',
      supportedUntil: computeSupportedUntil('2027-01-01T00:00:00.000Z'),
    };
    expect(superseded.supportedUntil).toBe('2028-01-01T00:00:00.000Z');
  });
});
