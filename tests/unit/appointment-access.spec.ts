import { describe, expect, it } from 'vitest';
import {
  issueAppointmentAccessToken,
  verifyAppointmentAccessToken,
} from '../../src/services/appointment-access';

describe('appointment selection tokens', () => {
  it('binds a short-lived token to the exact appointment and verified caller', () => {
    const now = Date.parse('2026-08-18T12:00:00.000Z');
    const token = issueAppointmentAccessToken('appt-fixture', '5551234567', now);
    expect(verifyAppointmentAccessToken(token, 'appt-fixture', '5551234567', '+1 555 123 4567', now)).toBe(true);
    expect(verifyAppointmentAccessToken(token, 'appt-other', '5551234567', '5551234567', now)).toBe(false);
    expect(verifyAppointmentAccessToken(token, 'appt-fixture', '5551234567', '5559990000', now)).toBe(false);
    expect(verifyAppointmentAccessToken(`${token}x`, 'appt-fixture', '5551234567', '5551234567', now)).toBe(false);
    expect(verifyAppointmentAccessToken(token, 'appt-fixture', '5551234567', '5551234567', now + 11 * 60_000)).toBe(false);
  });
});
