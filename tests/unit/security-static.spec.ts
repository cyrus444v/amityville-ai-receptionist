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

  it('keeps every voice tool behind the auth boundary', () => {
    const index = read('src/index.ts');
    expect(index).toContain("'/current-date'");
    expect(index).toContain('app.use(protectedToolPaths, toolAuth, rateLimiter)');
  });

  // The telephony vendor is gone and its webhook route with it. Whatever
  // replaces it arrives with a different signature scheme, so this pins the
  // absence rather than a scheme: a route added back without a deliberate
  // update to this test is a route nobody reviewed.
  it('mounts no unauthenticated webhook route', () => {
    expect(read('src/index.ts')).not.toMatch(/webhook/i);
    expect(fs.existsSync('src/routes/retell.ts')).toBe(false);
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
