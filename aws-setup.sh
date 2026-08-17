#!/bin/bash
set -euo pipefail

ACCOUNT_ID="668764275927"
REGION="us-east-1"
REPO_NAME="ai-receptionist-backend"
COORDINATION_TABLE="ai-receptionist-coordination"

echo "=== Step 2: Create ECR Repository ==="
aws ecr create-repository \
  --repository-name $REPO_NAME \
  --region $REGION \
  --image-scanning-configuration scanOnPush=true \
  2>/dev/null || echo "ECR repo already exists"

echo "=== Step 3: Create IAM Roles ==="

# ecsTaskExecutionRole
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }' 2>/dev/null || echo "ecsTaskExecutionRole already exists"

aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
  2>/dev/null || true

aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name SecretsManagerAccess \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":["secretsmanager:GetSecretValue"],
      "Resource":"arn:aws:secretsmanager:'$REGION':'$ACCOUNT_ID':secret:ai-receptionist/*"
    }]
  }' 2>/dev/null || true

# ecsTaskRole
aws iam create-role \
  --role-name ecsTaskRole \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }' 2>/dev/null || echo "ecsTaskRole already exists"

aws iam put-role-policy \
  --role-name ecsTaskRole \
  --policy-name CoordinationTableAccess \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem","dynamodb:Scan"],
      "Resource":"arn:aws:dynamodb:'$REGION':'$ACCOUNT_ID':table/'$COORDINATION_TABLE'"
    }]
  }' 2>/dev/null || true

echo "=== Step 4: Create Secrets in Secrets Manager ==="

if [[ -z "${GOOGLE_CREDENTIALS_BASE64_FILE:-}" ]]; then
  echo "GOOGLE_CREDENTIALS_BASE64_FILE must point to a readable file supplied by the operator." >&2
  exit 1
fi

if [[ ! -f "$GOOGLE_CREDENTIALS_BASE64_FILE" || ! -r "$GOOGLE_CREDENTIALS_BASE64_FILE" ]]; then
  echo "GOOGLE_CREDENTIALS_BASE64_FILE is not a readable regular file." >&2
  exit 1
fi

aws secretsmanager create-secret \
  --name "ai-receptionist/GOOGLE_CREDENTIALS_BASE64" \
  --secret-string "file://$GOOGLE_CREDENTIALS_BASE64_FILE" \
  --region "$REGION" \
  2>/dev/null || aws secretsmanager put-secret-value \
    --secret-id "ai-receptionist/GOOGLE_CREDENTIALS_BASE64" \
    --secret-string "file://$GOOGLE_CREDENTIALS_BASE64_FILE" \
    --region "$REGION"

for SECRET_NAME in APPOINTMENT_TOKEN_SECRET RETELL_WEBHOOK_SECRET; do
  FILE_VARIABLE="${SECRET_NAME}_FILE"
  SECRET_FILE="${!FILE_VARIABLE:-}"
  if [[ -z "$SECRET_FILE" || ! -f "$SECRET_FILE" || ! -r "$SECRET_FILE" ]]; then
    echo "$FILE_VARIABLE must point to a readable operator-supplied secret file." >&2
    exit 1
  fi
  if [[ $(wc -c < "$SECRET_FILE") -lt 32 ]]; then
    echo "$FILE_VARIABLE must contain at least 32 characters." >&2
    exit 1
  fi
  aws secretsmanager create-secret \
    --name "ai-receptionist/$SECRET_NAME" \
    --secret-string "file://$SECRET_FILE" \
    --region "$REGION" \
    2>/dev/null || aws secretsmanager put-secret-value \
      --secret-id "ai-receptionist/$SECRET_NAME" \
      --secret-string "file://$SECRET_FILE" \
      --region "$REGION"
done

if [[ -z "${TOOL_AUTH_SECRET_FILE:-}" ]]; then
  echo "TOOL_AUTH_SECRET_FILE must point to a readable operator-supplied secret file." >&2
  exit 1
fi

if [[ ! -f "$TOOL_AUTH_SECRET_FILE" || ! -r "$TOOL_AUTH_SECRET_FILE" ]]; then
  echo "TOOL_AUTH_SECRET_FILE is not a readable regular file." >&2
  exit 1
fi

if [[ $(wc -c < "$TOOL_AUTH_SECRET_FILE") -lt 32 ]]; then
  echo "TOOL_AUTH_SECRET_FILE must contain at least 32 characters." >&2
  exit 1
fi

aws secretsmanager create-secret \
  --name "ai-receptionist/TOOL_AUTH_SECRET" \
  --secret-string "file://$TOOL_AUTH_SECRET_FILE" \
  --region "$REGION" \
  2>/dev/null || aws secretsmanager put-secret-value \
    --secret-id "ai-receptionist/TOOL_AUTH_SECRET" \
    --secret-string "file://$TOOL_AUTH_SECRET_FILE" \
    --region "$REGION"

if [[ -n "${RESEND_API_KEY_FILE:-}" ]]; then
  if [[ ! -f "$RESEND_API_KEY_FILE" || ! -r "$RESEND_API_KEY_FILE" ]]; then
    echo "RESEND_API_KEY_FILE is not a readable regular file." >&2
    exit 1
  fi
  aws secretsmanager create-secret \
    --name "ai-receptionist/RESEND_API_KEY" \
    --secret-string "file://$RESEND_API_KEY_FILE" \
    --region "$REGION" \
    2>/dev/null || aws secretsmanager put-secret-value \
      --secret-id "ai-receptionist/RESEND_API_KEY" \
      --secret-string "file://$RESEND_API_KEY_FILE" \
      --region "$REGION"
else
  echo "Skipping optional RESEND_API_KEY secret; supply RESEND_API_KEY_FILE to configure it."
fi

echo "=== Step 5: Create ECS Cluster ==="
aws dynamodb create-table \
  --table-name "$COORDINATION_TABLE" \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION" \
  2>/dev/null || echo "Coordination table already exists"

aws dynamodb update-time-to-live \
  --table-name "$COORDINATION_TABLE" \
  --time-to-live-specification Enabled=true,AttributeName=ttl \
  --region "$REGION" \
  2>/dev/null || true

aws ecs create-cluster \
  --cluster-name ai-receptionist \
  --capacity-providers FARGATE \
  --region $REGION \
  2>/dev/null || echo "Cluster already exists"

echo "=== Create CloudWatch Log Group ==="
aws logs create-log-group \
  --log-group-name /ecs/ai-receptionist-backend \
  --region $REGION \
  2>/dev/null || echo "Log group already exists"

echo ""
echo "=== DONE: Steps 2-5 complete ==="
echo "ECR URI: $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO_NAME"
