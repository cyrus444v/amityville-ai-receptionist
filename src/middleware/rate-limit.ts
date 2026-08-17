import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { coordinationKey, incrementRateLimit } from '../services/coordination';

export function createRateLimiter(options: { windowMs: number; max: number; now?: () => number }) {
  const now = options.now ?? Date.now;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const timestamp = now();
    const windowStart = Math.floor(timestamp / options.windowMs) * options.windowMs;
    const actor = req.get(config.security.callIdHeader)
      || req.get(config.security.callerPhoneHeader)
      || req.ip
      || req.socket.remoteAddress
      || 'unknown';
    const key = coordinationKey('rate-limit', `${actor}|${windowStart}`);
    const resetAt = windowStart + options.windowMs;

    let count: number;
    try {
      count = await incrementRateLimit(key, resetAt + options.windowMs);
    } catch {
      res.status(503).json({ success: false, error: 'RATE_LIMIT_UNAVAILABLE' });
      return;
    }

    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    if (count > options.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - timestamp) / 1000))));
      res.status(429).json({ success: false, error: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' });
      return;
    }
    next();
  };
}
