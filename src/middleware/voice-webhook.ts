import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { voiceVendorClearance } from '../services/voice-vendor';

/**
 * Authentication for the two webhooks the voice vendor sends us.
 *
 * They are not the same mechanism and must not share one, because the vendor
 * treats them differently:
 *
 *  - The post-call webhook is signed by ElevenLabs. The scheme is not written
 *    down in their API reference; it was read out of their published SDK
 *    (@elevenlabs/elevenlabs-js, wrapper/webhooks.js) rather than guessed:
 *    header `elevenlabs-signature`, value `t=<unix seconds>,v0=<hex>`, where
 *    the hex is HMAC-SHA256 over the literal string `${t}.${rawBody}`.
 *
 *  - The conversation-initiation webhook is *not* signed. The vendor instead
 *    sends request headers we configure. So that one is a shared secret we
 *    issue, compared in constant time.
 *
 * Two deliberate departures from the vendor SDK's own implementation, both
 * strictly tighter:
 *
 *  1. Their timestamp check is one-sided — it rejects old timestamps but
 *     accepts one arbitrarily far in the future, which makes a captured request
 *     replayable forever. This checks both directions.
 *  2. Their digest comparison is a plain string `!==`. This uses
 *     timingSafeEqual, matching how every other secret in this codebase is
 *     compared.
 */

const SIGNATURE_HEADER = 'elevenlabs-signature';

export interface ParsedSignature {
  timestampSeconds: number;
  digestHex: string;
}

/** Parses `t=<seconds>,v0=<hex>`. Returns null for anything that is not exactly that. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts = header.split(',').map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith('t='));
  const digestPart = parts.find((part) => part.startsWith('v0='));
  if (!timestampPart || !digestPart) return null;

  const timestampSeconds = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestampSeconds)) return null;

  const digestHex = digestPart.slice(3);
  if (!/^[0-9a-f]+$/i.test(digestHex)) return null;

  return { timestampSeconds, digestHex };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a, 'utf8').digest();
  const right = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

export function expectedDigest(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/**
 * Refuses the request unless the operator has attested both PHI preconditions.
 * Outside production this warns instead, so the offline harness and a local run
 * still work without anybody attesting to a contract that does not apply there.
 */
export function requireVoiceVendorClearance(req: Request, res: Response, next: NextFunction): void {
  const clearance = voiceVendorClearance();
  if (clearance.cleared) {
    next();
    return;
  }
  if (!clearance.enforced) {
    logger.warn('Voice vendor webhook served without PHI clearance (non-production)', {
      blockers: clearance.blockers,
    });
    next();
    return;
  }
  logger.error('Refused voice vendor webhook: PHI preconditions not attested', {
    blockers: clearance.blockers,
  });
  res.status(503).json({
    success: false,
    error: 'VOICE_VENDOR_NOT_CLEARED',
    message: 'The voice vendor is not cleared to carry patient data in this environment.',
  });
}

/** Verifies the ElevenLabs signature on the post-call webhook. */
export function verifyPostCallSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = config.voice.webhookSecret;
  const reject = (reason: string): void => {
    logger.warn('Rejected post-call webhook', { reason });
    res.status(401).json({ success: false, error: 'INVALID_SIGNATURE' });
  };

  if (!secret) {
    // Fail closed. An unsigned transcript endpoint is an open PHI sink.
    logger.error('ELEVENLABS_WEBHOOK_SECRET is not set; refusing post-call webhook');
    res.status(503).json({ success: false, error: 'WEBHOOK_NOT_CONFIGURED' });
    return;
  }

  const header = req.get(SIGNATURE_HEADER);
  if (!header) return reject('missing signature header');

  const parsed = parseSignatureHeader(header);
  if (!parsed) return reject('malformed signature header');

  const skewMs = Math.abs(Date.now() - parsed.timestampSeconds * 1000);
  if (skewMs > config.voice.webhookToleranceMs) return reject('timestamp outside tolerance');

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return reject('raw body unavailable');

  const expected = expectedDigest(secret, String(parsed.timestampSeconds), rawBody.toString('utf8'));
  if (!constantTimeEquals(parsed.digestHex.toLowerCase(), expected)) return reject('digest mismatch');

  next();
}

/** Verifies the shared secret on the conversation-initiation webhook. */
export function verifyInitiationSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = config.voice.initiationSecret;
  if (!secret) {
    logger.error('ELEVENLABS_INITIATION_SECRET is not set; refusing initiation webhook');
    res.status(503).json({ success: false, error: 'WEBHOOK_NOT_CONFIGURED' });
    return;
  }

  const provided = req.get(config.voice.initiationHeader) ?? '';
  if (!provided || !constantTimeEquals(provided, secret)) {
    logger.warn('Rejected initiation webhook', { reason: 'bad or missing shared secret' });
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    return;
  }
  next();
}
