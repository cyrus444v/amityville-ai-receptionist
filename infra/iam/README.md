# Phase B provisioning permissions

`phase-b-provisioning-policy.json` is what the `aivance-deploy` IAM user needs in
order to create the two CloudFormation stacks. It is **temporary elevation of a
long-lived key** and should be detached the moment Phase B is finished.

## Attach

```bash
aws iam put-user-policy \
  --user-name aivance-deploy \
  --policy-name voice-agent-phase-b-provisioning \
  --policy-document file://infra/iam/phase-b-provisioning-policy.json
```

## Detach, when Phase B is done

```bash
aws iam delete-user-policy \
  --user-name aivance-deploy \
  --policy-name voice-agent-phase-b-provisioning
```

Then rotate the access key. It was pasted into an agent conversation, so it must be
considered exposed regardless of what it can do. After Phase B, deploys run through
the GitHub OIDC role the `tenant-service` stack creates — short-lived credentials,
no key to leak — and this user's standing permissions can go back to ECR push plus
`ecs:UpdateService`.

## Why each part exists

Derived from the resource types the two templates actually declare, not from a
general-purpose deploy policy.

| Statement | Why |
|---|---|
| `CloudFormationStacks` | create/update the stacks, and read events so a failure is diagnosable. Scoped to stack names `ai-receptionist-*` and `voice-agent-*`. |
| `CloudFormationAccountScopedCalls` | `ValidateTemplate` and `ListStacks` take no resource ARN. |
| `NetworkingReadAndSecurityGroups` | the two security groups (load balancer, task) plus reading the existing default VPC and subnets. EC2 create/authorize calls do not support resource-level scoping usefully. |
| `LoadBalancing` | the ALB, its two listeners, each clinic's target group, listener rule and listener certificate. ELBv2 creates cannot be resource-scoped before the resource exists. |
| `CoordinationTable` | the DynamoDB table, its TTL and its point-in-time recovery. Scoped to `table/ai-receptionist-*`. |
| `DiscoveryGapsFromPhaseBStepOne` | the four list calls the first sweep was denied, plus `GetRandomPassword`, which is what `GenerateSecretString` actually calls, plus the ECR mutability fix from the cleanup list. |
| `SecretContainers` | the five secret containers. Scoped to `secret:ai-receptionist/*`. **Note it grants no `GetSecretValue`** — this key never needs to read a secret's value, and the two secrets CloudFormation generates are meant to be readable by nobody but the task. |
| `LogGroups` | the log group and its retention. Scoped to `/ecs/ai-receptionist-*`. |
| `TaskAndDeployRoles` | the execution role, the task role and the GitHub deploy role. Scoped to `role/ai-receptionist-*`, so it cannot touch the pre-existing generic `ecsTaskRole`/`ecsTaskExecutionRole` or any unrelated role. |
| `PassOnlyTheTaskRolesAndOnlyToEcs` | `iam:PassRole` is the one that turns role-creation into privilege escalation, so it is restricted to the two task roles **and** conditioned on `iam:PassedToService = ecs-tasks.amazonaws.com`. |
| `GitHubOidcProvider` | the account-global OIDC provider, pinned to GitHub's exact provider ARN. |
| `EcrAuthTokenIsAccountScoped` | `ecr:GetAuthorizationToken` takes no resource ARN; it is what `docker login` calls. |
| `EcrPushTheBootstrapImage` | the first image has to be pushed by hand, because the service cannot be created without a task definition and the task definition cannot be registered without an image. Scoped to `repository/*-backend`. Every push after the first belongs to the GitHub OIDC deploy role the stack creates, which is why this is temporary too. |
| `EcsClustersServicesAndTaskDefinitions` | the two new clusters, the service, and task-definition registration. `RegisterTaskDefinition` is account-scoped by the API. |
| `CertificateForTheListener` | request and inspect the certificate for the clinic's hostname. ACM has no useful resource scoping for `RequestCertificate`. |

## What it deliberately does not grant

- `secretsmanager:GetSecretValue` — no reason for this key to read a secret value.
- `iam:*` beyond the role names above, and no `iam:CreateUser`, `CreateAccessKey`,
  `AttachUserPolicy` or `PutUserPolicy` — so the key cannot widen its own
  permissions.
- Anything on Route53. The domain's DNS is at GoDaddy; see the "Current AWS
  reality" section of `../../docs/INFRASTRUCTURE.md`.
- `dynamodb` data-plane actions (`GetItem`, `PutItem`, …). Those belong to the task
  role the stack creates, not to the deployer.
- `s3:*`, `lambda:*`, `rds:*` and every other service neither template touches.

## Seven statements use `Resource: "*"`

`CloudFormationAccountScopedCalls`, `NetworkingReadAndSecurityGroups`,
`LoadBalancing`, `DiscoveryGapsFromPhaseBStepOne`,
`EcrAuthTokenIsAccountScoped`, `EcsClustersServicesAndTaskDefinitions` and
`CertificateForTheListener`. In each
case that is because the AWS API rejects a resource ARN for those actions, or
because the resource does not exist yet at the moment of the call — not because
scoping was skipped for convenience. It is still real breadth: this policy can
create and delete load balancers, ECS clusters and security groups anywhere in the
account. That is the reason it is temporary.
