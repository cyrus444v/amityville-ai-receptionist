/**
 * The provisioning preflight, exercised for real.
 *
 * On 2 September 2026 scripts/provision-staging.sh deleted the staging ECS
 * cluster and the account's GitHub OIDC provider. Its preflight asked whether
 * each resource existed and, on yes, set the matching Create* parameter to
 * 'no'. Both resources belonged to the ai-receptionist-staging stack, so 'no'
 * dropped their CloudFormation condition and the update deleted them.
 *
 * These tests run the actual script under `--dry-run` with a stub `aws` on
 * PATH (tests/infra/fixtures/aws-stub/aws), so they cover the shell as written
 * rather than a description of it. No AWS call leaves the machine: the stub
 * refuses any call the script is not supposed to make.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const awsStubDir = resolve(__dirname, 'fixtures/aws-stub');
const script = resolve(repoRoot, 'scripts/provision-staging.sh');

type Account = {
  /** Status of ai-receptionist-staging; empty means the stack does not exist. */
  stackStatus?: string;
  /** Logical ids the stack currently owns. */
  owned?: string[];
  /** Is GitHub's OIDC provider present in the account at all? */
  oidcInAccount?: boolean;
  clusterStatus?: 'ACTIVE' | 'INACTIVE' | 'MISSING';
};

type Run = { status: number; stdout: string; stderr: string };

function preflight(account: Account, overrides: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync('bash', [script, '--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The stub shadows the real CLI. Even if a real aws is installed, the
        // script can only reach the fixture.
        PATH: `${awsStubDir}:${process.env.PATH ?? ''}`,
        FAKE_STACK_STATUS: account.stackStatus ?? '',
        FAKE_OWNED: (account.owned ?? []).join(' '),
        FAKE_OIDC_IN_ACCOUNT: account.oidcInAccount ? 'yes' : 'no',
        FAKE_CLUSTER_STATUS: account.clusterStatus ?? 'MISSING',
        ...overrides,
      },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const flag = (out: string, parameter: string): string | undefined =>
  out.match(new RegExp(`${parameter}=(yes|no)`))?.[1];

const LIVE_STACK = 'UPDATE_COMPLETE';

describe('create flags follow ownership, not existence', () => {
  it('keeps a resource this stack owns — the case that caused the outage', () => {
    // Exactly the 2 September account: the stack owned both resources, and
    // both therefore also existed. The old preflight answered 'no' to both.
    const run = preflight({
      stackStatus: LIVE_STACK,
      owned: ['Cluster', 'GitHubOidcProvider'],
      oidcInAccount: true,
      clusterStatus: 'ACTIVE',
    });

    expect(run.status).toBe(0);
    expect(flag(run.stdout, 'CreateCluster')).toBe('yes');
    expect(flag(run.stdout, 'CreateGitHubOidcProvider')).toBe('yes');
    expect(run.stdout).toContain('owns it — keeping it');
  });

  it('declines a resource that exists but belongs to someone else', () => {
    // Adoption is impossible, so 'no' is right here — this is the legitimate
    // case the old check was written for, and it still works.
    const run = preflight({
      stackStatus: LIVE_STACK,
      owned: [],
      oidcInAccount: true,
      clusterStatus: 'ACTIVE',
    });

    expect(run.status).toBe(0);
    expect(flag(run.stdout, 'CreateCluster')).toBe('no');
    expect(flag(run.stdout, 'CreateGitHubOidcProvider')).toBe('no');
    expect(run.stdout).toContain('exists outside the stack');
  });

  it('creates a resource that does not exist anywhere', () => {
    const run = preflight({
      stackStatus: LIVE_STACK,
      owned: [],
      oidcInAccount: false,
      clusterStatus: 'MISSING',
    });

    expect(run.status).toBe(0);
    expect(flag(run.stdout, 'CreateCluster')).toBe('yes');
    expect(flag(run.stdout, 'CreateGitHubOidcProvider')).toBe('yes');
    expect(run.stdout).toContain('does not exist yet');
  });

  it('falls back to the account when the stack does not exist yet', () => {
    // Nothing can be owned before the first deploy, so existence decides —
    // the original behaviour, unchanged.
    const fresh = preflight({ oidcInAccount: false, clusterStatus: 'MISSING' });
    expect(fresh.status).toBe(0);
    expect(flag(fresh.stdout, 'CreateCluster')).toBe('yes');
    expect(flag(fresh.stdout, 'CreateGitHubOidcProvider')).toBe('yes');
    expect(fresh.stdout).toContain('does not exist yet — nothing is owned');

    const shared = preflight({ oidcInAccount: true, clusterStatus: 'ACTIVE' });
    expect(shared.status).toBe(0);
    expect(flag(shared.stdout, 'CreateCluster')).toBe('no');
    expect(flag(shared.stdout, 'CreateGitHubOidcProvider')).toBe('no');
  });

  it('resolves the two resources independently', () => {
    const run = preflight({
      stackStatus: LIVE_STACK,
      owned: ['Cluster'],
      oidcInAccount: true,
      clusterStatus: 'ACTIVE',
    });

    expect(run.status).toBe(0);
    expect(flag(run.stdout, 'CreateCluster')).toBe('yes');
    expect(flag(run.stdout, 'CreateGitHubOidcProvider')).toBe('no');
  });
});

describe('an INACTIVE cluster is not an existing cluster', () => {
  it('recreates a cluster ECS still answers for as INACTIVE', () => {
    // A deleted ECS cluster stays queryable as INACTIVE. Reading that as
    // "exists" is what left the stack pointing at a dead cluster.
    const run = preflight({
      stackStatus: LIVE_STACK,
      owned: [],
      clusterStatus: 'INACTIVE',
    });

    expect(run.status).toBe(0);
    expect(flag(run.stdout, 'CreateCluster')).toBe('yes');
    expect(run.stdout).toContain('does not exist yet');
  });
});

describe('the guard against a silent delete', () => {
  it('refuses an override that would drop a resource the stack owns', () => {
    const run = preflight(
      {
        stackStatus: LIVE_STACK,
        owned: ['Cluster', 'GitHubOidcProvider'],
        oidcInAccount: true,
        clusterStatus: 'ACTIVE',
      },
      { CREATE_CLUSTER: 'no' },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('CreateCluster=no would delete a live resource');
    expect(run.stdout).not.toContain('Validating templates');
  });

  it('refuses the same for the OIDC provider', () => {
    const run = preflight(
      {
        stackStatus: LIVE_STACK,
        owned: ['GitHubOidcProvider'],
        oidcInAccount: true,
      },
      { CREATE_OIDC: 'no' },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('CreateGitHubOidcProvider=no would delete a live resource');
  });

  it('allows an override that does not delete anything', () => {
    const run = preflight(
      { stackStatus: LIVE_STACK, owned: [], oidcInAccount: true, clusterStatus: 'ACTIVE' },
      { CREATE_CLUSTER: 'no', CREATE_OIDC: 'no' },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Dry run complete');
  });
});

describe('the dry run stays read-only', () => {
  it('never reaches a deploy', () => {
    const run = preflight({ stackStatus: LIVE_STACK, owned: ['Cluster'] });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Dry run complete — nothing was deployed.');
    // The stub exits 99 on any call the script should not be making.
    expect(run.stdout).not.toContain('Deploying');
  });
});

describe('no script derives a create flag from bare existence', () => {
  // The behavioural tests above cover provision-staging.sh. This one is a
  // tripwire for the next script: the rule has to stay in one place, because
  // it is not the kind of thing anyone re-derives correctly under pressure.
  it('routes every create flag through the shared preflight library', () => {
    const shell = execFileSync(
      'git',
      ['ls-files', '-z', '--', 'scripts/*.sh', 'scripts/**/*.sh', '.github/workflows'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);

    const checked: string[] = [];
    for (const path of shell) {
      const source = readFileSync(resolve(repoRoot, path), 'utf8');
      if (!/Create(Cluster|GitHubOidcProvider)=/.test(source)) continue;
      checked.push(path);
      expect(source, `${path} must resolve create flags via scripts/lib/preflight.sh`)
        .toContain('scripts/lib/preflight.sh');
    }
    // Guard the guard: a glob that stops matching would pass vacuously.
    expect(checked).toContain('scripts/provision-staging.sh');
  });
});
