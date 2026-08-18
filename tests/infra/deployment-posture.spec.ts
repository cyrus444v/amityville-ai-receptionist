/**
 * Structural assertions over the infrastructure template and the deploy
 * workflow. These are cheap string-level guards in the same spirit as
 * tests/unit/security-static.spec.ts: they cannot prove AWS accepts the
 * template, but they do stop the blast-radius controls from being quietly
 * removed later.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(resolve(repoRoot, relative), 'utf8');

const template = read('infra/cloudformation/voice-agent-core.yml');
const deploy = read('.github/workflows/deploy.yml');
const ci = read('.github/workflows/ci.yml');

describe('coordination table', () => {
  it('enables TTL so coordination records expire instead of accumulating', () => {
    expect(template).toContain('TimeToLiveSpecification');
    expect(template).toMatch(/AttributeName: ttl\s+Enabled: true/);
  });

  it('encrypts at rest and survives a stack delete', () => {
    expect(template).toContain('SSEEnabled: true');
    expect(template).toMatch(/CoordinationTable:[\s\S]{0,200}DeletionPolicy: Retain/);
  });

  it('turns on point-in-time recovery and deletion protection for production only', () => {
    expect(template).toMatch(/production:[\s\S]{0,200}PointInTimeRecovery: true/);
    expect(template).toMatch(/production:[\s\S]{0,200}DeletionProtection: true/);
  });
});

describe('least privilege', () => {
  it('scopes the task role to exactly one table', () => {
    expect(template).toMatch(/coordination-table-access[\s\S]{0,900}'Fn::GetAtt': \[CoordinationTable, Arn\]/);
  });

  it('scopes secret reads to the five named service secrets', () => {
    const block = template.slice(template.indexOf('read-service-secrets'), template.indexOf('write-service-logs'));
    expect(block).toContain('secretsmanager:GetSecretValue');
    for (const secret of [
      'ToolAuthSecret', 'AppointmentTokenSecret', 'RetellWebhookSecret',
      'GoogleCredentialsSecret', 'ResendApiKeySecret',
    ]) {
      expect(block).toContain(`{ Ref: ${secret} }`);
    }
    expect(block).not.toContain("Resource: '*'");
  });

  it('uses a wildcard resource only where the AWS API requires it', () => {
    const wildcards = template.match(/Resource: '\*'/g) ?? [];
    // ecr:GetAuthorizationToken and ecs:RegisterTaskDefinition are account-scoped
    // APIs that reject a resource ARN.
    expect(wildcards).toHaveLength(2);
  });

  it('restricts PassRole to the two ECS roles', () => {
    expect(template).toContain("'iam:PassedToService': ecs-tasks.amazonaws.com");
  });

  it('never stores a literal secret value in the template', () => {
    // GenerateSecretString is allowed and preferred: CloudFormation mints the
    // tool and appointment-token secrets itself, so no human or agent ever
    // handles their plaintext. A bare SecretString would embed a literal value.
    expect(template).not.toMatch(/(?<!Generate)SecretString:/);
    expect(template).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(template).toContain('GenerateSecretString');
  });
});

describe('github deploy identity', () => {
  it('binds the trust policy to one repository and one environment', () => {
    expect(template).toContain("'token.actions.githubusercontent.com:sub'");
    expect(template).toContain('repo:${GitHubRepository}:environment:${EnvironmentName}');
  });

  it('requires the sts audience', () => {
    expect(template).toContain("'token.actions.githubusercontent.com:aud': sts.amazonaws.com");
  });
});

describe('deploy workflow', () => {
  it('stays manual and quality-gated', () => {
    expect(deploy).toContain('workflow_dispatch:');
    expect(deploy).toContain('needs: quality');
    expect(deploy).not.toContain('branches: [main]');
  });

  it('binds each job to a fixed protected environment', () => {
    expect(deploy).toContain('environment: staging');
    expect(deploy).toContain('environment: production');
    expect(deploy).not.toContain('environment: ${{');
  });

  it('requires a typed confirmation before production can run', () => {
    expect(deploy).toContain("inputs.confirm_production == 'DEPLOY PRODUCTION'");
  });

  it('uses short-lived OIDC credentials instead of long-lived keys', () => {
    expect(deploy).toContain('id-token: write');
    expect(deploy).toContain('role-to-assume:');
    expect(deploy).not.toContain('AWS_ACCESS_KEY_ID');
    expect(deploy).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('deploys an immutable commit-tagged image via the renderer', () => {
    expect(deploy).toContain('IMAGE_TAG: ${{ github.sha }}');
    expect(deploy).toContain('infra/render.mjs --env staging');
    expect(deploy).toContain('infra/render.mjs --env production');
    expect(deploy).not.toContain('ecs-task-definition.json');
  });

  it('runs the offline voice harness in the quality gate', () => {
    expect(deploy).toContain('npm run harness');
  });

  it('keeps the smoke test read-only and credential-free', () => {
    const smoke = read('scripts/smoke.mjs');
    expect(smoke).toContain('/health');
    expect(smoke).not.toContain('TOOL_AUTH_SECRET');
    for (const mutating of ['create-appointment', 'reschedule-appointment', 'cancel-appointment', 'create-callback']) {
      expect(smoke, `smoke test must never call ${mutating}`).not.toContain(mutating);
    }
  });
});

describe('ci workflow', () => {
  it('keeps the quality gate and adds the harness', () => {
    expect(ci).toContain('npm run test:ci');
    expect(ci).toContain('npm run harness');
    expect(ci).toContain('npm audit --omit=dev --audit-level=high');
    expect(ci).toContain('persist-credentials: false');
  });
});
