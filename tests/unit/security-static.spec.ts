import fs from 'fs';
import { describe, expect, it } from 'vitest';

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('security regressions in operator and delivery files', () => {
  it('keeps credentials out of the AWS setup script', () => {
    const script = read('aws-setup.sh');
    expect(script).toContain('GOOGLE_CREDENTIALS_BASE64_FILE');
    expect(script).toContain('file://$GOOGLE_CREDENTIALS_BASE64_FILE');
    expect(script).toContain('file://$TOOL_AUTH_SECRET_FILE');
    expect(script).not.toContain('__REDACTED_' + 'EMBEDDED_CREDENTIAL__');
    expect(script).not.toContain('BEGIN ' + 'PRIVATE KEY');
    expect(script).not.toContain('private_' + 'key_id');
    expect(script).not.toMatch(/GOOGLE_B64\s*=/);
  });

  it('keeps lookup misses free of last-row fallback and raw phone logging', () => {
    const booking = read('src/services/booking.ts');
    const routes = read('src/routes/appointments.ts');
    expect(booking).not.toMatch(/filter\([^\n]+confirmed[^\n]+\.at\(-1\)/);
    expect(routes).not.toContain('stored_phones');
  });

  it('keeps every Retell tool authenticated and verifies signed webhooks', () => {
    const index = read('src/index.ts');
    const webhook = read('src/routes/retell.ts');
    expect(index).toContain("'/current-date'");
    expect(webhook).toContain("req.get('x-retell-signature')");
    expect(webhook).toContain("createHmac('sha256'");
    expect(webhook).toContain('rawBody + match[1]');
  });

  it('uses shared atomic coordination for slots, retries, callbacks, and limits', () => {
    const coordination = read('src/services/coordination.ts');
    const booking = read('src/services/booking.ts');
    expect(coordination).toContain('TransactWriteItemsCommand');
    expect(coordination).toContain('ConditionExpression');
    expect(booking).toContain("coordinationKey('appointment-slot'");
    expect(booking).toContain('reconcilePendingAppointmentMutations');
  });

  it('keeps production deployment manual, quality-gated, and protected', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toContain('workflow_dispatch:');
    expect(deploy).toContain('needs: quality');
    expect(deploy).toContain('environment: production');
    expect(deploy).not.toContain('branches: [main]');
  });
});
