import { describe, expect, it, vi } from 'vitest';
import { logger, sanitizeLogMeta } from '../../src/utils/logger';

describe('log redaction', () => {
  it('redacts nested patient fields, arrays, and raw bodies recursively', () => {
    const sanitized = sanitizeLogMeta({
      stored_phones: ['5551234567'],
      nested: [{ phone: '5559990000', email: 'patient@example.test', date_of_birth: '1990-01-01' }],
      body: { caller_name: 'Fixture Patient', phone: '5551112222' },
      request_body: 'raw fixture body',
    });
    const output = JSON.stringify(sanitized);
    expect(output).not.toContain('555');
    expect(output).not.toContain('patient@example.test');
    expect(output).not.toContain('1990-01-01');
    expect(output).not.toContain('Fixture Patient');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts phone and email values even under an unexpected key', () => {
    const output = JSON.stringify(sanitizeLogMeta({ detail: 'Call +1 (555) 123-4567 or patient@example.test' }));
    expect(output).not.toContain('123-4567');
    expect(output).not.toContain('patient@example.test');
  });

  it('does not leak the pre-fix phone-list regression through logger output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.info('find-appointment lookup', {
      incoming: '5551234567',
      stored_phones: ['5550001111', '5550002222'],
    });
    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toMatch(/555\d+/);
  });
});
