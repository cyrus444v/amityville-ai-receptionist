/**
 * The PHI gate.
 *
 * ElevenLabs' own HIPAA page is unambiguous: PHI may be handled only where a
 * BAA has been executed *and* Zero Retention Mode is engaged, and an agent
 * without ZRM "is no longer deemed a covered service for purposes of the BAA".
 * Neither fact is visible from inside this process, so both are attestations —
 * and in production an unmade attestation stops the call rather than logging a
 * note nobody reads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { voiceVendorClearance } from '../../src/services/voice-vendor';

afterEach(() => { vi.unstubAllEnvs(); });

describe('voice vendor PHI clearance', () => {
  it('is not cleared when neither attestation has been made', () => {
    const clearance = voiceVendorClearance();
    expect(clearance.cleared).toBe(false);
    expect(clearance.blockers).toHaveLength(2);
  });

  it('names both missing preconditions so the operator knows what to do', () => {
    const { blockers } = voiceVendorClearance();
    expect(blockers.join(' ')).toContain('ELEVENLABS_BAA_ATTESTED');
    expect(blockers.join(' ')).toContain('ELEVENLABS_ZERO_RETENTION');
  });

  it('only enforces in production, so local and harness runs are unaffected', () => {
    expect(voiceVendorClearance().enforced).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(voiceVendorClearance().enforced).toBe(true);
  });

  it('blocks in production while an attestation is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const clearance = voiceVendorClearance();
    expect(clearance.enforced && !clearance.cleared).toBe(true);
  });
});
