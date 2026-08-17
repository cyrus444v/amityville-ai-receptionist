import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  coordinationKey,
  getCoordinationRecord,
  putCoordinationRecord,
} from '../services/coordination';

interface StoredResponse {
  fingerprint: string;
  statusCode: number;
  body: unknown;
  expiresAt: number;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(req: Request): string {
  return crypto.createHash('sha256').update(stableStringify(req.body ?? null)).digest('hex');
}

export function createIdempotencyMiddleware(options: { ttlMs: number; now?: () => number }) {
  const cache = new Map<string, StoredResponse>();
  const inFlight = new Map<string, Promise<StoredResponse>>();
  const now = options.now ?? Date.now;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.get('Idempotency-Key');
    if (!header) {
      next();
      return;
    }
    if (header.length > 200) {
      res.status(400).json({ success: false, error: 'INVALID_IDEMPOTENCY_KEY' });
      return;
    }

    const key = `${req.path}:${header}`;
    const requestFingerprint = fingerprint(req);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      if (cached.fingerprint !== requestFingerprint) {
        res.status(409).json({ success: false, error: 'IDEMPOTENCY_KEY_REUSED' });
        return;
      }
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(cached.statusCode).json(cached.body);
      return;
    }
    if (cached) cache.delete(key);

    const durableKey = coordinationKey('http-idempotency', key);
    const durableOwner = crypto.randomUUID();
    try {
      const durable = await getCoordinationRecord(durableKey);
      if (durable) {
        if (durable.fingerprint !== requestFingerprint) {
          res.status(409).json({ success: false, error: 'IDEMPOTENCY_KEY_REUSED' });
          return;
        }
        if (durable.state === 'pending') {
          res.status(409).json({ success: false, error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
          return;
        }
        res.setHeader('Idempotency-Replayed', 'durable');
      } else {
        const inserted = await putCoordinationRecord(durableKey, {
          owner: durableOwner,
          state: 'pending',
          fingerprint: requestFingerprint,
          expiresAt: now() + options.ttlMs,
        }, true);
        if (!inserted) {
          res.status(409).json({ success: false, error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
          return;
        }
      }
    } catch {
      res.status(503).json({ success: false, error: 'IDEMPOTENCY_UNAVAILABLE' });
      return;
    }

    const pending = inFlight.get(key);
    if (pending) {
      const stored = await pending;
      if (stored.fingerprint !== requestFingerprint) {
        res.status(409).json({ success: false, error: 'IDEMPOTENCY_KEY_REUSED' });
        return;
      }
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(stored.statusCode).json(stored.body);
      return;
    }

    let resolveStored!: (stored: StoredResponse) => void;
    const responsePromise = new Promise<StoredResponse>((resolve) => { resolveStored = resolve; });
    inFlight.set(key, responsePromise);

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const stored: StoredResponse = {
        fingerprint: requestFingerprint,
        statusCode: res.statusCode,
        body,
        expiresAt: now() + options.ttlMs,
      };
      if (res.statusCode >= 200 && res.statusCode < 500) {
        void putCoordinationRecord(durableKey, {
          owner: durableOwner,
          state: 'completed',
          fingerprint: requestFingerprint,
          expiresAt: stored.expiresAt,
        }).then(() => {
          if (!cache.has(key) && cache.size >= 10_000) {
            const oldest = cache.keys().next().value as string | undefined;
            if (oldest) cache.delete(oldest);
          }
          cache.set(key, stored);
          inFlight.delete(key);
          resolveStored(stored);
          originalJson(body);
        }).catch(() => {
          const unavailable: StoredResponse = {
            ...stored,
            statusCode: 503,
            body: { success: false, error: 'IDEMPOTENCY_UNAVAILABLE' },
          };
          inFlight.delete(key);
          resolveStored(unavailable);
          res.status(503);
          originalJson(unavailable.body);
        });
        return res;
      }
      inFlight.delete(key);
      resolveStored(stored);
      return originalJson(body);
    }) as Response['json'];

    res.once('close', () => {
      if (inFlight.has(key)) {
        const stored: StoredResponse = {
          fingerprint: requestFingerprint,
          statusCode: 503,
          body: { success: false, error: 'REQUEST_INTERRUPTED' },
          expiresAt: now(),
        };
        inFlight.delete(key);
        resolveStored(stored);
      }
    });

    next();
  };
}
