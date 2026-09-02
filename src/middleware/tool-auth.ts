import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export function secretsMatch(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

export function toolAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = config.security.toolAuthSecret;
  if (!secret && process.env.NODE_ENV !== 'production') {
    next();
    return;
  }

  const provided = req.get(config.security.toolAuthHeader) ?? '';
  if (!secret || !provided || !secretsMatch(provided, secret)) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      auth_version: config.security.toolAuthVersion,
      message: 'Valid tool credentials are required.',
    });
    return;
  }

  res.setHeader('X-Tool-Auth-Version', config.security.toolAuthVersion);
  next();
}
