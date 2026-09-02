/**
 * Structural checks over the two CloudFormation templates.
 *
 * Neither template has ever been submitted to AWS, so nothing here proves AWS
 * accepts them. What it does prove is that they parse, that every Ref and
 * Fn::Sub names something the template actually declares, and that the isolation
 * properties the multi-tenant design rests on are present — a misspelt Ref is
 * otherwise only discovered by a failed stack operation.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const repoRoot = resolve(__dirname, '../..');

interface Template {
  Parameters?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
  Mappings?: Record<string, unknown>;
  Resources: Record<string, { Type: string; Condition?: string; Properties?: any; DeletionPolicy?: string }>;
  Outputs?: Record<string, { Condition?: string; Value?: unknown }>;
}

function parse(relative: string): Template {
  return load(readFileSync(resolve(repoRoot, relative), 'utf8')) as Template;
}

const sharedAlb = parse('infra/cloudformation/shared-alb.yml');
const tenantService = parse('infra/cloudformation/tenant-service.yml');

/** Pseudo-parameters CloudFormation always provides. */
const PSEUDO = new Set(['AWS::AccountId', 'AWS::Region', 'AWS::StackName', 'AWS::Partition', 'AWS::NoValue', 'AWS::URLSuffix', 'AWS::StackId']);

function known(template: Template): Set<string> {
  return new Set([
    ...Object.keys(template.Parameters ?? {}),
    ...Object.keys(template.Resources),
    ...PSEUDO,
  ]);
}

/**
 * ELB attribute lists (LoadBalancerAttributes, TargetGroupAttributes) type their
 * Value as String. CloudFormation will coerce a Number-parameter Ref or a
 * FindInMap onto an unquoted YAML boolean, so this is not about a rejected
 * stack — it is about the templates declaring the type the property actually
 * takes instead of relying on coercion. Resolve each value far enough to know
 * what type it produces.
 */
function resolvesToString(value: unknown, template: Template): boolean {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, any>;
  if ('Fn::Sub' in node) return typeof node['Fn::Sub'] === 'string';
  if ('Ref' in node) return (template.Parameters?.[node.Ref] as any)?.Type === 'String';
  if ('Fn::FindInMap' in node) {
    const [mapName, , key] = node['Fn::FindInMap'];
    const map = (template.Mappings?.[mapName] ?? {}) as Record<string, Record<string, unknown>>;
    const entries = Object.values(map);
    return entries.length > 0 && entries.every((entry) => typeof entry[key] === 'string');
  }
  return false;
}

/** Every { Key, Value } pair under a property whose name ends in "Attributes". */
function attributePairs(node: unknown, found: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const item of node) attributePairs(item, found);
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/Attributes$/.test(key) && Array.isArray(value)) found.push(...value);
      else attributePairs(value, found);
    }
  }
  return found;
}

/** Every name a Ref, Fn::GetAtt or Fn::Sub placeholder points at. */
function referencedNames(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) referencedNames(item, found);
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'Ref' && typeof value === 'string') found.push(value);
      else if (key === 'Fn::GetAtt') {
        const target = Array.isArray(value) ? value[0] : String(value).split('.')[0];
        found.push(String(target));
      } else if (key === 'Fn::Sub' && typeof value === 'string') {
        for (const match of value.matchAll(/\$\{([^}]+)\}/g)) found.push(match[1].split('.')[0]);
      } else referencedNames(value, found);
    }
  }
  return found;
}

describe.each([
  ['shared-alb.yml', sharedAlb],
  ['tenant-service.yml', tenantService],
])('%s', (_name, template) => {
  it('declares a version and a description', () => {
    expect((template as any).AWSTemplateFormatVersion).toBe('2010-09-09');
    expect((template as any).Description).toBeTruthy();
  });

  it('resolves every reference to something it declares', () => {
    const declared = known(template);
    const dangling = [...new Set(referencedNames(template.Resources).concat(referencedNames(template.Outputs ?? {})))]
      .filter((name) => !declared.has(name));
    expect(dangling, `these names are referenced but never declared: ${dangling.join(', ')}`).toEqual([]);
  });

  it('resolves every condition it uses', () => {
    const conditions = new Set(Object.keys(template.Conditions ?? {}));
    const used = [
      ...Object.values(template.Resources).map((resource) => resource.Condition),
      ...Object.values(template.Outputs ?? {}).map((output) => output.Condition),
    ].filter((name): name is string => Boolean(name));
    for (const name of used) expect(conditions.has(name), `unknown condition ${name}`).toBe(true);
  });

  it('states plainly that it has never reached AWS', () => {
    expect((template as any).Description).toContain('NEVER SUBMITTED TO AWS');
  });

  it('gives every load balancer attribute a value that resolves to a string', () => {
    const pairs = attributePairs(template.Resources);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(resolvesToString(pair.Value, template), `${pair.Key} does not resolve to a string`).toBe(true);
    }
  });
});

describe('the shared load balancer', () => {
  const listener = sharedAlb.Resources.HttpsListener;

  it('is one load balancer for every clinic, per environment', () => {
    const balancers = Object.values(sharedAlb.Resources)
      .filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(balancers).toHaveLength(1);
    expect(balancers[0].Properties.Scheme).toBe('internet-facing');
  });

  it('answers an unrecognised host with a 404 rather than routing it somewhere', () => {
    const [action] = listener.Properties.DefaultActions;
    expect(action.Type).toBe('fixed-response');
    expect(action.FixedResponseConfig.StatusCode).toBe('404');
  });

  it('terminates TLS on a modern policy and drops invalid headers', () => {
    expect(listener.Properties.Protocol).toBe('HTTPS');
    expect(listener.Properties.SslPolicy).toMatch(/TLS13/);
    const attributes = sharedAlb.Resources.LoadBalancer.Properties.LoadBalancerAttributes;
    expect(attributes).toEqual(expect.arrayContaining([
      { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
    ]));
  });

  it('redirects plain HTTP instead of serving it', () => {
    const [action] = sharedAlb.Resources.HttpRedirectListener.Properties.DefaultActions;
    expect(action.Type).toBe('redirect');
    expect(action.RedirectConfig.Protocol).toBe('HTTPS');
  });

  it('exports what a tenant stack needs to attach itself', () => {
    for (const output of ['HttpsListenerArn', 'LoadBalancerSecurityGroupId', 'LoadBalancerDnsName', 'LoadBalancerHostedZoneId']) {
      expect(sharedAlb.Outputs, `missing output ${output}`).toHaveProperty(output);
    }
  });
});

describe('one clinic per stack', () => {
  it('names the clinic it serves', () => {
    expect(tenantService.Parameters).toHaveProperty('TenantSlug');
    expect(tenantService.Parameters).toHaveProperty('HostName');
  });

  it('routes by host header, so one balancer can serve many clinics', () => {
    const rule = tenantService.Resources.ListenerRule;
    expect(rule.Type).toBe('AWS::ElasticLoadBalancingV2::ListenerRule');
    const [condition] = rule.Properties.Conditions;
    expect(condition.Field).toBe('host-header');
    expect(condition.HostHeaderConfig.Values).toEqual([{ Ref: 'HostName' }]);
  });

  it('adds its own certificate rather than replacing the listener default', () => {
    expect(tenantService.Resources.ListenerCertificate.Type)
      .toBe('AWS::ElasticLoadBalancingV2::ListenerCertificate');
  });

  it('accepts traffic only from the shared load balancer', () => {
    const ingress = tenantService.Resources.TaskSecurityGroup.Properties.SecurityGroupIngress;
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({
      FromPort: 8080,
      ToPort: 8080,
      SourceSecurityGroupId: { Ref: 'LoadBalancerSecurityGroupId' },
    });
    expect(JSON.stringify(ingress)).not.toContain('0.0.0.0/0');
  });

  it('health-checks the one unauthenticated endpoint the app exposes', () => {
    expect(tenantService.Resources.TargetGroup.Properties.HealthCheckPath).toBe('/health');
  });

  it('creates the cluster before the service that runs in it', () => {
    // A Ref to the ClusterName parameter is only a string: it would leave no
    // edge in the dependency graph, so the service could be created first.
    const cluster = tenantService.Resources.Service.Properties.Cluster;
    expect(cluster['Fn::If']).toEqual([
      'ShouldCreateCluster',
      { Ref: 'Cluster' },
      { Ref: 'ClusterName' },
    ]);
  });

  it('rolls a bad deployment back on its own', () => {
    const deployment = tenantService.Resources.Service.Properties.DeploymentConfiguration;
    expect(deployment.DeploymentCircuitBreaker).toEqual({ Enable: true, Rollback: true });
    expect(deployment.MinimumHealthyPercent).toBe(100);
  });

  it('reaches the clinic\'s own table and no other', () => {
    const policy = tenantService.Resources.TaskRole.Properties.Policies
      .find((entry: { PolicyName: string }) => entry.PolicyName === 'coordination-table-access');
    const resources = policy.PolicyDocument.Statement[0].Resource;
    expect(resources).toEqual([{ 'Fn::GetAtt': ['CoordinationTable', 'Arn'] }]);
  });

  it('reads the clinic\'s own five secrets and no others', () => {
    const policy = tenantService.Resources.TaskExecutionRole.Properties.Policies
      .find((entry: { PolicyName: string }) => entry.PolicyName === 'read-service-secrets');
    const resources = policy.PolicyDocument.Statement[0].Resource;
    expect(resources).toEqual([
      { Ref: 'ToolAuthSecret' },
      { Ref: 'AppointmentTokenSecret' },
      { Ref: 'RetellWebhookSecret' },
      { Ref: 'GoogleCredentialsSecret' },
      { Ref: 'ResendApiKeySecret' },
    ]);
  });

  it('keeps the coordination table and log group across a stack delete', () => {
    for (const name of ['CoordinationTable', 'LogGroup']) {
      expect(tenantService.Resources[name].DeletionPolicy, `${name} must be retained`).toBe('Retain');
    }
  });

  it('lets the deploy role roll only this clinic\'s service', () => {
    const policy = tenantService.Resources.DeployRole.Properties.Policies[0].PolicyDocument;
    const updateService = policy.Statement
      .find((statement: any) => JSON.stringify(statement.Action).includes('ecs:UpdateService'));
    expect(JSON.stringify(updateService.Resource)).toContain('service/${ClusterName}/${ServiceName}-backend');
  });

  it('uses a wildcard resource only for the two account-scoped APIs', () => {
    const policy = tenantService.Resources.DeployRole.Properties.Policies[0].PolicyDocument;
    const wildcards = policy.Statement.filter((statement: any) => statement.Resource === '*');
    expect(wildcards.flatMap((statement: any) => statement.Action).sort()).toEqual([
      'ecr:GetAuthorizationToken', 'ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition',
    ]);
  });
});
