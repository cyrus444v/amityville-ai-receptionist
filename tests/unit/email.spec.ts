import { describe, expect, it } from 'vitest';
import { escapeHtml, renderConfirmationEmail } from '../../src/services/email';
import { tenant } from '../../src/config/tenant';

describe('confirmation email safety', () => {
  it('escapes caller-controlled HTML characters', () => {
    expect(escapeHtml('<a href="https://evil.test">Patient & Co</a>'))
      .toBe('&lt;a href=&quot;https://evil.test&quot;&gt;Patient &amp; Co&lt;/a&gt;');
  });

  it('escapes a caller name inside the rendered body', () => {
    const rendered = renderConfirmationEmail({
      to: 'patient@example.invalid',
      caller_name: '<script>alert(1)</script>',
      service: 'Acupuncture',
      date: '2026-08-26',
      time: '15:00',
      duration_minutes: 60,
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe('confirmation email identity', () => {
  const rendered = renderConfirmationEmail({
    to: 'patient@example.invalid',
    caller_name: 'Dana Reyes',
    service: 'Acupuncture',
    date: '2026-08-26',
    time: '15:00',
    duration_minutes: 60,
  });

  it('sends as the clinic in the tenant configuration', () => {
    expect(rendered.from).toBe(`${tenant.display_name} <${tenant.email.from}>`);
    expect(rendered.replyTo).toBe(tenant.email.reply_to);
  });

  it('signs the footer with the clinic\'s own locality', () => {
    // The clinic's own name contains an ampersand, so the footer is compared
    // against the escaped form — the escaping is the point, not an obstacle.
    expect(rendered.html).toContain(
      `${escapeHtml(tenant.display_name)} · ${escapeHtml(tenant.email.footer_locality)}`,
    );
  });

  it('states the appointment it is confirming', () => {
    expect(rendered.subject).toContain('Acupuncture');
    expect(rendered.html).toContain('Wednesday, August 26, 2026');
    expect(rendered.html).toContain('3:00 PM');
    expect(rendered.html).toContain('60 minutes');
  });
});
