import crypto from 'crypto';
import type { Request } from 'express';
import { config } from '../config';
import { normalisePhone } from '../utils/parse-datetime';

interface AppointmentAccessPayload {
  appointmentId: string;
  phoneHash: string;
  expiresAt: number;
}

function secret(): string {
  return config.security.appointmentTokenSecret || config.security.toolAuthSecret;
}

function phoneHash(phone: string): string {
  return crypto.createHmac('sha256', secret()).update(normalisePhone(phone), 'utf8').digest('hex');
}

function signature(encodedPayload: string): string {
  return crypto.createHmac('sha256', secret()).update(encodedPayload, 'utf8').digest('base64url');
}

export function callerPhoneFromRequest(req: Request): string | undefined {
  const value = req.get(config.security.callerPhoneHeader);
  if (!value) return undefined;
  const normalized = normalisePhone(value);
  return normalized.length >= 4 ? normalized : undefined;
}

export function issueAppointmentAccessToken(
  appointmentId: string,
  phone: string,
  now: number = Date.now(),
): string {
  if (!secret()) throw new Error('Appointment token secret is not configured.');
  const payload: AppointmentAccessPayload = {
    appointmentId,
    phoneHash: phoneHash(phone),
    expiresAt: now + config.security.appointmentTokenTtlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

export function verifyAppointmentAccessToken(
  token: string,
  appointmentId: string,
  storedPhone: string,
  callerPhone: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!secret() || !callerPhone || normalisePhone(storedPhone) !== normalisePhone(callerPhone)) return false;
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra) return false;

  const expected = signature(encoded);
  const suppliedBuffer = Buffer.from(suppliedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AppointmentAccessPayload;
    return payload.appointmentId === appointmentId
      && payload.phoneHash === phoneHash(storedPhone)
      && Number.isFinite(payload.expiresAt)
      && payload.expiresAt >= now;
  } catch {
    return false;
  }
}
