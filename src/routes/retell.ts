import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

export function verifyRetellSignature(
  rawBody: string,
  signature: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  const match = /^v=(\d+),d=([a-f0-9]{64})$/i.exec(signature);
  if (!match || !secret) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > config.security.webhookToleranceMs) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody + match[1], 'utf8').digest('hex');
  const suppliedBuffer = Buffer.from(match[2].toLowerCase(), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

router.post('/retell/webhook', (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
  const signature = req.get('x-retell-signature') ?? '';
  if (!verifyRetellSignature(rawBody, signature, config.security.webhookSecret)) {
    return res.status(401).json({ success: false, error: 'INVALID_RETELL_SIGNATURE' });
  }

  const event = typeof req.body?.event === 'string' ? req.body.event : 'unknown';
  logger.info('Verified Retell webhook received', { event });
  return res.status(204).send();
});

export default router;
