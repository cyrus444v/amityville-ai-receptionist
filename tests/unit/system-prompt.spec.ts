/**
 * The committed retell/system-prompt.txt is tenant #1's live agent prompt: it is
 * what the static eval checks its invariants against, and what a real caller
 * hears the effect of. Templating it is only safe if the template plus the
 * tenant file reproduce it exactly, so that is asserted byte-for-byte.
 *
 * The hours block is generated from the tenant's structured business_hours
 * rather than from prose, so the last test here pins it against what booking.ts
 * actually enforces. A prompt that advertises hours the backend rejects sends
 * callers to a closed clinic.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Plain ESM, shared with scripts/render-retell-agent.mjs.
import { formatSpokenTime, renderBusinessHours, renderSystemPrompt } from '../../retell/render-prompt.mjs';
import { tenant } from '../../src/config/tenant';
import { checkAvailability } from '../../src/services/booking';

const repoRoot = resolve(__dirname, '../..');
const templateText = readFileSync(resolve(repoRoot, 'retell/system-prompt.template.txt'), 'utf8');
const committedPrompt = readFileSync(resolve(repoRoot, 'retell/system-prompt.txt'), 'utf8');

describe('the templated prompt reproduces the live prompt', () => {
  const rendered: string = renderSystemPrompt({ templateText, tenant });

  it('renders tenant #1 byte-for-byte', () => {
    expect(rendered).toBe(committedPrompt);
  });

  it('leaves no placeholder unresolved', () => {
    expect(rendered).not.toMatch(/\{\{[a-z0-9_]+\}\}/);
  });

  it('refuses to render a tenant whose prompt block is incomplete', () => {
    const crippled = { ...tenant, prompt: { ...tenant.prompt, spoken_name: undefined } };
    expect(() => renderSystemPrompt({ templateText, tenant: crippled }))
      .toThrow(/Unresolved prompt placeholders: clinic_name/);
  });
});

describe('the template carries no clinic identity of its own', () => {
  it.each(['amityville', 'broadway', '631.691', '631.532', 'hurme', 'long island'])(
    'does not mention %s',
    (marker) => {
      expect(templateText.toLowerCase()).not.toContain(marker);
    },
  );

  it('keeps the reusable call machinery', () => {
    for (const section of [
      'ONE QUESTION AT A TIME', 'BOOKING FLOW', 'CANCELLATION FLOW', 'RESCHEDULING FLOW',
      'CALLBACK FLOW', 'SERVICE INFORMATION RULES', 'EMERGENCY ESCALATION',
      'DATE AND TIME RULES', 'TOOL RULES',
    ]) {
      expect(templateText).toContain(section);
    }
  });
});

describe('spoken hours', () => {
  it('formats whole and part hours the way a receptionist says them', () => {
    expect(formatSpokenTime('09:00')).toBe('9 AM');
    expect(formatSpokenTime('12:00')).toBe('12 PM');
    expect(formatSpokenTime('17:00')).toBe('5 PM');
    expect(formatSpokenTime('00:00')).toBe('12 AM');
    expect(formatSpokenTime('09:30')).toBe('9:30 AM');
    expect(formatSpokenTime('13:45')).toBe('1:45 PM');
  });

  it('names every open day and collects the closed ones', () => {
    const block: string = renderBusinessHours(tenant.business_hours);
    expect(block).toBe([
      '- Tuesday: 9 AM – 5 PM',
      '- Wednesday: 9 AM – 5 PM',
      '- Friday: 9 AM – 5 PM',
      '- Saturday: 9 AM – 12 PM',
      '- Monday, Thursday, Sunday: CLOSED',
    ].join('\n'));
  });

  it('advertises only hours the backend will actually accept', async () => {
    // Monday 24 August 2026 through Sunday the 30th — a full future week, so no
    // probe is refused merely for being in the past. Only the day-and-hours
    // verdicts are asserted: each resolves before any calendar call, so this
    // stays an offline check of the prompt against the booking rules.
    const dates: Record<string, string> = {
      monday: '2026-08-24', tuesday: '2026-08-25', wednesday: '2026-08-26',
      thursday: '2026-08-27', friday: '2026-08-28', saturday: '2026-08-29',
      sunday: '2026-08-30',
    };
    const anHourBefore = (time: string) => `${String(Number(time.slice(0, 2)) - 1).padStart(2, '0')}:${time.slice(3)}`;

    for (const [day, date] of Object.entries(dates)) {
      const hours = tenant.business_hours[day as keyof typeof tenant.business_hours];
      if (hours.closed) {
        const closed = await checkAvailability(date, '10:00');
        expect(closed.status, `the prompt calls ${day} closed`).toBe('CLOSED_DAY');
        continue;
      }
      const beforeOpening = await checkAvailability(date, anHourBefore(hours.open));
      expect(beforeOpening.status, `${day} opens at ${hours.open}`).toBe('OUTSIDE_HOURS');

      const atClosing = await checkAvailability(date, hours.close);
      expect(atClosing.status, `${day} closes at ${hours.close}`).toBe('OUTSIDE_HOURS');
    }
  });
});
