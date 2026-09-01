import { config } from '../config';

/**
 * The compliance gate on the voice vendor.
 *
 * Routing a call through ElevenLabs Agents sends live patient speech to a third
 * party. Their own documentation is explicit about what makes that permissible
 * for PHI: an executed BAA (Enterprise tier only) *and* Zero Retention Mode
 * engaged on the agent. It is equally explicit about the consequence of missing
 * either — an agent without ZRM "is no longer deemed a covered service for
 * purposes of the BAA", and no PHI may be submitted to it.
 *
 * Neither condition is something this code can verify from inside the process:
 * one is a signed contract, the other is a setting in someone else's dashboard.
 * So they are recorded here as two separate operator attestations, and in
 * production the webhooks refuse to run until both are made. That is a
 * deliberate choice to fail closed on a legal precondition rather than to
 * discover it was never met by reading it in a breach notification.
 */

export interface VendorClearance {
  cleared: boolean;
  /** Empty when cleared; otherwise one sentence per unmet precondition. */
  blockers: string[];
  /** True when a failure here should stop the request rather than warn. */
  enforced: boolean;
}

export function voiceVendorClearance(): VendorClearance {
  const blockers: string[] = [];

  if (!config.voice.baaAttested) {
    blockers.push(
      'ELEVENLABS_BAA_ATTESTED is not "true": no signed Business Associate Agreement has been attested for the voice vendor.',
    );
  }
  if (!config.voice.zeroRetention) {
    blockers.push(
      'ELEVENLABS_ZERO_RETENTION is not "true": Zero Retention Mode has not been attested as engaged on the agent.',
    );
  }

  return {
    cleared: blockers.length === 0,
    blockers,
    enforced: process.env.NODE_ENV === 'production',
  };
}
