#!/usr/bin/env bash
#
# Provisions the staging infrastructure for one clinic, in the order the stacks
# depend on each other. Everything it needs from the account was established by
# the 19 August 2026 discovery and is baked in as a default below; override any
# of it with an environment variable.
#
#   scripts/provision-staging.sh --dry-run   # preflight + template validation only
#   scripts/provision-staging.sh             # preflight, validate, then deploy
#
# This is pass 1: it creates everything except the ECS service, because the
# service needs a task definition that does not exist until an image is pushed.
# The script prints the exact pass-2 commands when it finishes.
#
# It never reads, writes or prints a secret value. The two generated secrets are
# minted by CloudFormation inside AWS; the three operator-supplied ones are
# created empty and filled with `aws secretsmanager put-secret-value` by hand.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:-668764275927}"
TENANT="${TENANT:-amityville-wellness}"
SERVICE_NAME="${SERVICE_NAME:-ai-receptionist}"
ENVIRONMENT=staging

VPC_ID="${VPC_ID:-vpc-013d30115da21e448}"
SUBNET_IDS="${SUBNET_IDS:-subnet-0af34467789fd745e,subnet-07e1fa6100fc4d8c6}"
STAGING_CERT_ARN="${STAGING_CERT_ARN:-arn:aws:acm:us-east-1:668764275927:certificate/68ffef65-1b24-4006-90f0-e6973f0b4d55}"
HOST_NAME="${HOST_NAME:-api-staging.amityvillewellness.com}"
CLUSTER_NAME="${CLUSTER_NAME:-${SERVICE_NAME}-${ENVIRONMENT}}"
LISTENER_RULE_PRIORITY="${LISTENER_RULE_PRIORITY:-100}"

ALB_STACK="voice-agent-${ENVIRONMENT}-alb"
TENANT_STACK="${SERVICE_NAME}-${ENVIRONMENT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=no
[ "${1:-}" = "--dry-run" ] && DRY_RUN=yes

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

say "Preflight"

CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "No usable AWS credentials. Configure a profile with the permissions in
  infra/iam/phase-b-provisioning-policy.json, then re-run. Never paste a key into
  an agent session — run 'aws configure --profile <name>' yourself and export
  AWS_PROFILE."

[ "$CALLER_ACCOUNT" = "$ACCOUNT_ID" ] \
  || die "Credentials are for account $CALLER_ACCOUNT, expected $ACCOUNT_ID."
echo "ok    account $CALLER_ACCOUNT, region $REGION"

CERT_STATUS="$(aws acm describe-certificate --region "$REGION" \
  --certificate-arn "$STAGING_CERT_ARN" \
  --query 'Certificate.Status' --output text 2>/dev/null)" \
  || die "Cannot read the staging certificate $STAGING_CERT_ARN."

if [ "$CERT_STATUS" != "ISSUED" ]; then
  echo "      certificate status is $CERT_STATUS, not ISSUED."
  echo "      Add this CNAME at GoDaddy and wait for validation:"
  aws acm describe-certificate --region "$REGION" --certificate-arn "$STAGING_CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
  die "The HTTPS listener cannot be created until the certificate is ISSUED."
fi
echo "ok    certificate ISSUED for $HOST_NAME"

# GitHub's OIDC provider is account-global; creating it twice fails the stack.
if aws iam list-open-id-connect-providers \
     --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')]" \
     --output text | grep -q .; then
  CREATE_OIDC=no
  echo "ok    GitHub OIDC provider already exists — CreateGitHubOidcProvider=no"
else
  CREATE_OIDC=yes
  echo "ok    no GitHub OIDC provider yet — CreateGitHubOidcProvider=yes"
fi

# The cluster may already exist from an earlier pass.
if aws ecs describe-clusters --region "$REGION" --clusters "$CLUSTER_NAME" \
     --query 'clusters[?status==`ACTIVE`]' --output text | grep -q .; then
  CREATE_CLUSTER=no
  echo "ok    cluster $CLUSTER_NAME exists — CreateCluster=no"
else
  CREATE_CLUSTER=yes
  echo "ok    cluster $CLUSTER_NAME does not exist — CreateCluster=yes"
fi

# --------------------------------------------------------------- validation

say "Validating templates against AWS"
for template in shared-alb tenant-service; do
  aws cloudformation validate-template --region "$REGION" \
    --template-body "file://${REPO_ROOT}/infra/cloudformation/${template}.yml" \
    --query 'Description' --output text >/dev/null \
    || die "$template.yml was rejected by CloudFormation."
  echo "ok    ${template}.yml accepted"
done

if [ "$DRY_RUN" = yes ]; then
  say "Dry run complete — nothing was deployed."
  exit 0
fi

# ------------------------------------------------------------------ deploy

say "Deploying $ALB_STACK (one shared load balancer for this environment)"
aws cloudformation deploy --region "$REGION" \
  --template-file "${REPO_ROOT}/infra/cloudformation/shared-alb.yml" \
  --stack-name "$ALB_STACK" \
  --parameter-overrides \
      "EnvironmentName=${ENVIRONMENT}" \
      "VpcId=${VPC_ID}" \
      "PublicSubnetIds=${SUBNET_IDS}" \
      "DefaultCertificateArn=${STAGING_CERT_ARN}"

albout() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$ALB_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
LISTENER_ARN="$(albout HttpsListenerArn)"
ALB_SG="$(albout LoadBalancerSecurityGroupId)"
ALB_DNS="$(albout LoadBalancerDnsName)"
echo "ok    listener $LISTENER_ARN"
echo "ok    load balancer $ALB_DNS"

say "Deploying $TENANT_STACK (everything clinic $TENANT owns, except the service)"
aws cloudformation deploy --region "$REGION" \
  --template-file "${REPO_ROOT}/infra/cloudformation/tenant-service.yml" \
  --stack-name "$TENANT_STACK" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      "EnvironmentName=${ENVIRONMENT}" \
      "TenantSlug=${TENANT}" \
      "ServiceName=${SERVICE_NAME}" \
      "ClusterName=${CLUSTER_NAME}" \
      "CreateCluster=${CREATE_CLUSTER}" \
      "CreateGitHubOidcProvider=${CREATE_OIDC}" \
      "HostName=${HOST_NAME}" \
      "CertificateArn=${STAGING_CERT_ARN}" \
      "ListenerRulePriority=${LISTENER_RULE_PRIORITY}" \
      "HttpsListenerArn=${LISTENER_ARN}" \
      "LoadBalancerSecurityGroupId=${ALB_SG}" \
      "VpcId=${VPC_ID}" \
      "TaskSubnetIds=${SUBNET_IDS}" \
      "AssignPublicIp=ENABLED" \
      "BootstrapTaskDefinitionArn="

say "Stack outputs"
aws cloudformation describe-stacks --region "$REGION" --stack-name "$TENANT_STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table

# -------------------------------------------------------------- next steps

cat <<NEXT

Pass 1 done. Nothing serves traffic yet — the service is deliberately not created
until a task definition exists.

Still to do, in this order:

1. DNS. Add a CNAME at GoDaddy:
     ${HOST_NAME}  ->  ${ALB_DNS}

2. Fill the three operator-supplied secrets. TOOL_AUTH_SECRET and
   APPOINTMENT_TOKEN_SECRET are already generated inside AWS — do not touch them.
     aws secretsmanager put-secret-value --region ${REGION} \\
       --secret-id ${SERVICE_NAME}/${ENVIRONMENT}/GOOGLE_CREDENTIALS_BASE64 \\
       --secret-string file://<path-to-base64-key>
   Same for RESEND_API_KEY. Never echo these values.

3. Build and push the image, then register the task definition:
     SHA=\$(git rev-parse HEAD)
     aws ecr get-login-password --region ${REGION} \\
       | docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com
     docker build -t ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${SERVICE_NAME}-backend:\$SHA .
     docker push ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${SERVICE_NAME}-backend:\$SHA
     npm run infra:render -- --tenant ${TENANT} --env ${ENVIRONMENT} --image-tag \$SHA
     aws ecs register-task-definition --region ${REGION} \\
       --cli-input-json file://infra/generated/task-definition.${TENANT}.${ENVIRONMENT}.json

4. Re-run this stack with the task definition ARN that returns, which creates the
   service:
     aws cloudformation deploy ... BootstrapTaskDefinitionArn=<arn from step 3>
   (same parameters as above; every other value is unchanged)

5. Smoke-test the boundary, read-only:
     npm run smoke -- https://${HOST_NAME}

NEXT
