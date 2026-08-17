import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/services/email';

describe('confirmation email safety', () => {
  it('escapes caller-controlled HTML characters', () => {
    expect(escapeHtml('<a href="https://evil.test">Patient & Co</a>'))
      .toBe('&lt;a href=&quot;https://evil.test&quot;&gt;Patient &amp; Co&lt;/a&gt;');
  });
});
