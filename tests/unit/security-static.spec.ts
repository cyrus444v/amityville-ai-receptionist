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

  // This test used to pin the *absence* of any webhook route, on the grounds
  // that a route added back without a deliberate update here is a route nobody
  // reviewed. Two have now been added back deliberately, for the ElevenLabs
  // Agents integration, so the test changes from pinning absence to pinning
  // that each one carries authentication and the PHI gate. The old telephony
  // vendor's route stays gone.
  it('mounts every webhook route behind authentication and the PHI gate', () => {
    const index = read('src/index.ts');
    expect(fs.existsSync('src/routes/retell.ts')).toBe(false);

    // Each mounted voice hook names its own verifier. A hook added later
    // without one fails here.
    const mounts = [...index.matchAll(/app\.post\(\s*'(\/voice\/[^']+)',([^;]*?)\);/gs)];
    expect(mounts.length).toBeGreaterThanOrEqual(2);
    for (const [, path, body] of mounts) {
      expect(body, `${path} is not gated on PHI clearance`).toContain('requireVoiceVendorClearance');
      expect(body, `${path} has no signature or secret check`)
        .toMatch(/verifyPostCallSignature|verifyInitiationSecret/);
    }
  });

  it('verifies the vendor signature in constant time and bounds it in both directions', () => {
    const middleware = read('src/middleware/voice-webhook.ts');
    expect(middleware).toContain('timingSafeEqual');
    // Math.abs is what makes the timestamp window two-sided. The vendor's own
    // SDK checks only the lower bound, which leaves a captured request
    // replayable forever if its timestamp is in the future.
    expect(middleware).toContain('Math.abs(Date.now()');
    // No secret, no service: an unsigned transcript endpoint is an open PHI sink.
    expect(middleware).toContain('WEBHOOK_NOT_CONFIGURED');
  });

  it('does not persist call transcripts before the retention question is settled', () => {
    expect(read('src/routes/voice.ts')).toContain('transcript_persisted: false');
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
