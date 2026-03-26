#!/bin/bash
# AgentPeek Server — one-command deploy
#
# Usage:
#   ./install.sh                           # Interactive (prompts for region)
#   ./install.sh --region us-west-2        # Non-interactive
#   ./install.sh --region us-west-2 --stack MyStack --repo my-repo
#
# What it does:
#   1. Creates ECR repo (if needed)
#   2. Uploads source to S3
#   3. Builds Docker image via CodeBuild (arm64, no local Docker needed)
#   4. Deploys/updates CloudFormation stack
#   5. Prints API URL + API Key + bridge command

set -euo pipefail

# ===== Parse args =====
REGION=""
STACK_NAME="AgentPeek"
REPO_NAME="agentpeek-api"
TAG="latest"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --stack)  STACK_NAME="$2"; shift 2 ;;
    --repo)   REPO_NAME="$2"; shift 2 ;;
    --tag)    TAG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Interactive if no region
if [ -z "$REGION" ]; then
  read -p "AWS Region (default: us-east-1): " REGION
  REGION=${REGION:-us-east-1}
fi

echo ""
echo "================================================"
echo "AgentPeek Server — Deploy"
echo "================================================"
echo "  Region: $REGION"
echo "  Stack:  $STACK_NAME"
echo "  Repo:   $REPO_NAME"
echo "  Tag:    $TAG"
echo "================================================"
echo ""

# ===== Prerequisites =====
echo "Checking prerequisites..."
command -v aws >/dev/null 2>&1 || { echo "ERROR: AWS CLI required"; exit 1; }
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || { echo "ERROR: AWS credentials not configured"; exit 1; }
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  Account: $ACCOUNT_ID"
echo "  OK"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
TEMPLATE="$SCRIPT_DIR/template/AgentPeek.template"
REPO_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}"
BUCKET="${REPO_NAME}-build-${REGION}-${ACCOUNT_ID}"
CODEBUILD_PROJECT="${STACK_NAME}-build"
CODEBUILD_ROLE="${STACK_NAME}-codebuild-role"

# ===== Step 1: ECR =====
echo "[1/5] Creating ECR repository..."
aws ecr create-repository --repository-name "$REPO_NAME" --region "$REGION" >/dev/null 2>&1 \
  && echo "  Created: $REPO_NAME" \
  || echo "  Already exists: $REPO_NAME"

# ===== Step 2: Upload source to S3 =====
echo "[2/5] Uploading source to S3..."
aws s3 mb "s3://${BUCKET}" --region "$REGION" >/dev/null 2>&1 || true
(cd "$SRC_DIR" && zip -qr /tmp/swift-chat-src.zip .)
aws s3 cp /tmp/swift-chat-src.zip "s3://${BUCKET}/src.zip" --region "$REGION" --quiet
rm -f /tmp/swift-chat-src.zip
echo "  Uploaded to s3://${BUCKET}/src.zip"

# ===== Step 3: CodeBuild =====
echo "[3/5] Building Docker image via CodeBuild..."

# Create CodeBuild role if needed
if ! aws iam get-role --role-name "$CODEBUILD_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$CODEBUILD_ROLE" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' >/dev/null
  aws iam put-role-policy --role-name "$CODEBUILD_ROLE" --policy-name build-policy \
    --policy-document '{
      "Version":"2012-10-17",
      "Statement":[
        {"Effect":"Allow","Action":["ecr:*"],"Resource":"*"},
        {"Effect":"Allow","Action":["ecr-public:GetAuthorizationToken","sts:GetServiceBearerToken"],"Resource":"*"},
        {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion"],"Resource":"arn:aws:s3:::'"$BUCKET"'/*"},
        {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}
      ]
    }'
  echo "  Created IAM role: $CODEBUILD_ROLE"
  echo "  Waiting for role propagation..."
  sleep 10
fi

# Create or update CodeBuild project
BUILDSPEC="version: 0.2
phases:
  pre_build:
    commands:
      - aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
      - aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REPO_URI
  build:
    commands:
      - docker build -t $REPO_NAME:$TAG -f Dockerfile .
      - docker tag $REPO_NAME:$TAG $REPO_URI:$TAG
  post_build:
    commands:
      - docker push $REPO_URI:$TAG"

BUILDSPEC_JSON=$(echo "$BUILDSPEC" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")

if aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT" --region "$REGION" --query 'projects[0].name' --output text 2>/dev/null | grep -q "$CODEBUILD_PROJECT"; then
  aws codebuild update-project --name "$CODEBUILD_PROJECT" --region "$REGION" \
    --source '{"type":"S3","location":"'"$BUCKET"'/src.zip","buildspec":'"$BUILDSPEC_JSON"'}' \
    >/dev/null
else
  aws codebuild create-project --name "$CODEBUILD_PROJECT" --region "$REGION" \
    --source '{"type":"S3","location":"'"$BUCKET"'/src.zip","buildspec":'"$BUILDSPEC_JSON"'}' \
    --artifacts '{"type":"NO_ARTIFACTS"}' \
    --environment '{"type":"ARM_CONTAINER","image":"aws/codebuild/amazonlinux2-aarch64-standard:3.0","computeType":"BUILD_GENERAL1_SMALL","privilegedMode":true}' \
    --service-role "arn:aws:iam::${ACCOUNT_ID}:role/${CODEBUILD_ROLE}" \
    >/dev/null
fi

# Start build and wait
BUILD_ID=$(aws codebuild start-build --project-name "$CODEBUILD_PROJECT" --region "$REGION" \
  --query 'build.id' --output text)
echo "  Build started: $BUILD_ID"

while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].buildStatus' --output text)
  PHASE=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].currentPhase' --output text)
  printf "\r  Status: %-12s Phase: %-15s" "$STATUS" "$PHASE"
  if [ "$STATUS" != "IN_PROGRESS" ]; then break; fi
  sleep 5
done
echo ""

if [ "$STATUS" != "SUCCEEDED" ]; then
  echo "ERROR: Build failed with status: $STATUS"
  echo "Check logs: aws codebuild batch-get-builds --ids $BUILD_ID --region $REGION"
  exit 1
fi
echo "  Image: $REPO_URI:$TAG"

# ===== Step 4: CloudFormation =====
echo "[4/5] Deploying CloudFormation stack..."
IMAGE_URI="$REPO_URI:$TAG"
IMAGES_BUCKET="$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]')-images-${ACCOUNT_ID}"

STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$STACK_EXISTS" = "DOES_NOT_EXIST" ]; then
  aws cloudformation create-stack \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --template-body "file://$TEMPLATE" \
    --parameters "ParameterKey=ContainerImageUri,ParameterValue=$IMAGE_URI" "ParameterKey=ImagesBucketName,ParameterValue=$IMAGES_BUCKET" \
    --capabilities CAPABILITY_IAM >/dev/null
  echo "  Creating stack..."
  aws cloudformation wait stack-create-complete --stack-name "$STACK_NAME" --region "$REGION"
else
  aws cloudformation update-stack \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --template-body "file://$TEMPLATE" \
    --parameters "ParameterKey=ContainerImageUri,ParameterValue=$IMAGE_URI" "ParameterKey=ImagesBucketName,ParameterValue=$IMAGES_BUCKET" \
    --capabilities CAPABILITY_IAM >/dev/null 2>&1 \
    && { echo "  Updating stack..."; aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" --region "$REGION"; } \
    || echo "  No stack changes needed"
fi
echo "  Stack ready: $STACK_NAME"

# ===== Step 5: Output =====
echo "[5/5] Getting connection info..."
echo ""

API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`APIURL`].OutputValue' --output text)

KEY_ID=$(aws apigateway get-api-keys --region "$REGION" \
  --query "items[?name=='${STACK_NAME}-api-key'].id" --output text)
API_KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --region "$REGION" \
  --query 'value' --output text)

echo "================================================"
echo "  Deploy complete!"
echo "================================================"
echo ""
echo "  API URL:  $API_URL"
echo "  API Key:  $API_KEY"
echo ""
echo "  Bridge (run on your Mac/Linux):"
echo "    node bridge/bridge.mjs --server $API_URL --key $API_KEY"
echo ""
echo "  QR code data (for SwiftChat app):"
echo "    {\"type\":\"swiftchat-bridge\",\"server\":\"$API_URL\",\"apiKey\":\"$API_KEY\"}"
echo ""
echo "================================================"
