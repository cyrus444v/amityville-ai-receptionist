#!/bin/bash
set -e

ACCOUNT_ID="668764275927"
REGION="us-east-1"
REPO_NAME="ai-receptionist-backend"

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

echo "=== Step 4: Create Secrets in Secrets Manager ==="

GOOGLE_B64=$(cat << 'EOF'
ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCiAgInByb2plY3RfaWQiOiAiYW1pdHl2aWxsZS1hdXRvbWF0aW9uIiwKICAicHJpdmF0ZV9rZXlfaWQiOiAiY2RkODQyYTBhNGJhMDc0ZDcxMDE4OWY0Yjk3ZWI5YjhlZDQzZmQxNCIsCiAgInByaXZhdGVfa2V5IjogIi0tLS0tQkVHSU4gUFJJVkFURSBLRVktLS0tLVxuTUlJRXZnSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2d3Z2dTa0FnRUFBb0lCQVFDU2d2Vm1XeUdjdlBEd1xuWkMwbVFTbGMvRWZ4a1F2V0FLcHhWVW5CZXp6alhHOVNUaHhGemtGaGF5QXBjWUlFUVUwMHFzdDdPblNNb2RicVxuSXhDMEdEanZ3elpCbDVpNUNJNVpmQlQ0M05ZWHJ5Q0h3c09vS1lkajNzMkNGQUsxdEI0a1Jva2lnQVVjNDJEL1xuNmRXb1U5T2pQNmt1cFV6Q1g2dTU5TzFzV2V4bE5NaWlqVXV3YjAxZVQ4K0ZYQ3VZRUhzNmU2bGZrc0Q0anZCL1xuaWZjSExxcUVaeDFFczVuTnR5amRJZzJyTlhsYXo4cDl1OXY4OUFzMk80d1R2T0M2Nnk0NkN6bXNNa1ZENXRhd1xuSHE0UmorT1A2dmo0TDZXdk93NldwMkdNb1cwWUFLWkhFR1c1QTFjdlVGOUUzSHRIR1BTSDd3dW54YlNFbkdRZFxuQWdDY21nVURBZ01CQUFFQ2dnRUFDdHhXczZxUUZjM2R4ZEdFbFVyaG9ENTZyaVMvUTEyK1JNalA2Yk5UTFZRclxuVTd4dGxSdk5OZkJhZ2RLanZZd0NYS1B5a2VVZ2x2emlSbTMrQXRPdTJOQ0M3a2wrRisxVFJyMDZLQms2d2xFSVxuUmlMQkhVU2kxWVpDZkF1SlhlTXh2cytwd25CMHNKSmNja0ZwRzJGeUZWa1dsMW9kUHJyQ2dLRHdQckYxelg5Y1xuK2c4SDNZVHFWNnVuKzlyT3Bma1BXcko5VFh0MG5CcDRITTE4OFZUQWpMaFpocWtlcnFsN2xEUGwxNW56VXJiVlxuU0lKV3pMRDdBY3Z5RlVFQVBVWHhXTnA2SzFlWUE0NlNyNlI0bk9ORXF0Qm14UHVYWHJUVG00T25GUnRsNFFkRVxuK3lpNWxUZjZlK3BnVG5xTFR2YzN6V3dlQ010VDdMTkEwSHN1OTdXZjJRS0JnUURESlFwNDVkaVRPS25hdkVySlxudWdXazFqWkt4dzhubDl0Z001dEJMZlpxcm1nZW5sczd2M2c1SDNxeCsveUJjZUpLcmNlbmRQWkIrSTF6VVV6R1xuQnIzbGVKT1g3QzhqaXNmb0JiZ1RjQXROOUdJWU1pY0pLREVhRVFlSXZQdUN5M3ZSSU9rTTBUVWlJUm5OSTExWFxucHlybWt1TERsbkNuMHEzTnBOQ3JMeTNzS3dLQmdRREFNMlU3QXAxb3VxYlBDYTdGekFrOVNFRWVhajVEK1ZZaVxuR3pYNTAxV0FVWGNaZUl1MWpKdW1KczZ4UXNVaHR1bURIVEt4bDRXRWMyd2xra2Q4Vy9CTkhTRmVpZUYrWTBKSFxuRmJ0VklrcnFkWmwvc3NXeVk1Q2dZSFg0RHh4NGJldG5DYzFGTjlxNnFQRHd4ejlFU1VOZTdKTytsM2xhZ1pWOVxuS2VXczdJam1pUUtCZ0VuS29mRWhpUW55clZnSFI0aU1qVUhOdHU0RDQ5a205VStsZEJucmxYaTF4cTE5V0NaNVxudXE1dkZ1aGl6eExyeTVSTnJtZkdOTEN4bWx0MjdMOGRJWVc2V0tWa0xGY1dUWTJSVEJBZG1FaThGclBya3hORlxuWFh2cjRKdDJTdTBrb1FkdG1ISytVWWM0V1JOWFFoNjVHZUhpdlZrVWREa2gwNU1sdGJwbHRzbk5Bb0dCQUxNQlxucXpDd21NWm53T0JuRmozbWNGeUJKUlVjd20wd2xnWWg3YjJHRk1YMEdjYkJQTzJUell1TDdVbXU5RWNZUXBmNFxuNDdQL2VUMEkreHByQ09WTUE1enVtcHVnTTBJeFZCTThyRUw0TTJuMnFVWUR6Smorbmo2Z1dJS3YyRVpacWJ0SFxucDhUbDVuT2UwUGlQdWQ3eGxTdWRqMlVkVXNyMmtiSUhDWUJxdEg1eEFvR0JBSXVXN0RpZXgwTjM1UmhDZFJUd1xuSi9VM1haSGRtWE1TVXJTakZzMWZ4LzcvLzBMeTVKWE9wcFFTTDRQVGowdmVyVkQvSUVObjRYNVJ5aXBzN0FaUVxuK0hQU0dod2RnRXhNTzRtNHlYc2w0ZTN3cGYyVjdUNHliR1hPVFhaMjdpVW5pbm1OdWp0OTU2Z2VGT1p5bDdNb1xubVBqMnFpa3BOUmJiNkNyeURpTSt0VjZCXG4tLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tXG4iLAogICJjbGllbnRfZW1haWwiOiAiYW1pdHl2aWxsZS1yZWNlcHRpb25pc3RAYW1pdHl2aWxsZS1hdXRvbWF0aW9uLmlhbS5nc2VydmljZWFjY291bnQuY29tIiwKICAiY2xpZW50X2lkIjogIjExNTMxMDAyNjkzNDM4NDc2NTI0MiIsCiAgImF1dGhfdXJpIjogImh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbS9vL29hdXRoMi9hdXRoIiwKICAidG9rZW5fdXJpIjogImh0dHBzOi8vb2F1dGgyLmdvb2dsZWFwaXMuY29tL3Rva2VuIiwKICAiYXV0aF9wcm92aWRlcl94NTA5X2NlcnRfdXJsIjogImh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL29hdXRoMi92MS9jZXJ0cyIsCiAgImNsaWVudF94NTA5X2NlcnRfdXJsIjogImh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL3JvYm90L3YxL21ldGFkYXRhL3g1MDkvYW1pdHl2aWxsZS1yZWNlcHRpb25pc3QlNDBhbWl0eXZpbGxlLWF1dG9tYXRpb24uaWFtLmdzZXJ2aWNlYWNjb3VudC5jb20iLAogICJ1bml2ZXJzZV9kb21haW4iOiAiZ29vZ2xlYXBpcy5jb20iCn0K
EOF
)

aws secretsmanager create-secret \
  --name "ai-receptionist/GOOGLE_CREDENTIALS_BASE64" \
  --secret-string "$GOOGLE_B64" \
  --region $REGION \
  2>/dev/null || aws secretsmanager put-secret-value \
    --secret-id "ai-receptionist/GOOGLE_CREDENTIALS_BASE64" \
    --secret-string "$GOOGLE_B64" \
    --region $REGION

aws secretsmanager create-secret \
  --name "ai-receptionist/RESEND_API_KEY" \
  --secret-string "PLACEHOLDER_UPDATE_LATER" \
  --region $REGION \
  2>/dev/null || echo "RESEND secret already exists"

echo "=== Step 5: Create ECS Cluster ==="
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
