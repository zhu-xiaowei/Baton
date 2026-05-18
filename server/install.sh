#!/bin/bash
# AgentPeek Server — one-command deploy
#
# Usage:
#   ./install.sh                           # Interactive (prompts for region)
#   ./install.sh --region us-west-2        # Non-interactive
#   ./install.sh --region us-west-2 --stack MyStack --repo my-repo
#
# What it does:
#   1. Build server Docker image (ECR + CodeBuild)
#   2. Deploy CloudFormation stack + update Lambdas
#   3. Upload bridge install package to S3
#   4. Print connection info + bridge install command

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
S3_BUCKET="$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]')-${REGION}-images-${ACCOUNT_ID}"
CODEBUILD_PROJECT="${STACK_NAME}-build"
CODEBUILD_ROLE="${STACK_NAME}-codebuild-role"

# Ensure S3 bucket exists (shared for build artifacts, bridge package, images)
aws s3 mb "s3://${S3_BUCKET}" --region "$REGION" >/dev/null 2>&1 || true

# ===== Step 1: Build server Docker image =====
echo "[1/4] Building server Docker image..."

# ECR repo
aws ecr create-repository --repository-name "$REPO_NAME" --region "$REGION" >/dev/null 2>&1 \
  && echo "  ECR created: $REPO_NAME" \
  || echo "  ECR exists: $REPO_NAME"

# Stage build context: server/src/* + frontend sources (web/, package.json, vite.config.js, lock).
# Vite build happens inside the Dockerfile (multi-stage) — no host node dependency required.
WEB_DIR="$SCRIPT_DIR/../web"
ROOT_DIR="$SCRIPT_DIR/.."
BUILD_CTX=$(mktemp -d)
trap 'rm -rf "$BUILD_CTX"' EXIT

# Server files (Dockerfile + python sources + requirements)
cp -r "$SRC_DIR"/. "$BUILD_CTX/"
rm -f "$BUILD_CTX/test_api.py" 2>/dev/null || true
# Frontend sources (Dockerfile stage 1 builds vite from these)
cp -r "$WEB_DIR" "$BUILD_CTX/web"
rm -f "$BUILD_CTX/web/test_api.py" 2>/dev/null || true
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$ROOT_DIR/vite.config.js" "$BUILD_CTX/"

# Read version from version.json
VERSION_FILE="$SCRIPT_DIR/../version.json"
if [ -f "$VERSION_FILE" ]; then
  APP_VERSION=$(python3 -c "import json; d=json.load(open('$VERSION_FILE')); print(d['version'])" 2>/dev/null || echo "dev")
  echo "  Version: $APP_VERSION"
fi

# Upload source (Vite + web + python all in one build context)
(cd "$BUILD_CTX" && zip -qr /tmp/agentpeek-src.zip .)
aws s3 cp /tmp/agentpeek-src.zip "s3://${S3_BUCKET}/build/src.zip" --region "$REGION" --quiet
rm -f /tmp/agentpeek-src.zip

# Create CodeBuild role if needed
if ! aws iam get-role --role-name "$CODEBUILD_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$CODEBUILD_ROLE" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' >/dev/null
  echo "  Created IAM role: $CODEBUILD_ROLE"
  echo "  Waiting for role propagation..."
  sleep 10
fi
# Always update policy (S3 bucket may change between deploys)
aws iam put-role-policy --role-name "$CODEBUILD_ROLE" --policy-name build-policy \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[
      {"Effect":"Allow","Action":["ecr:*"],"Resource":"*"},
      {"Effect":"Allow","Action":["ecr-public:GetAuthorizationToken","sts:GetServiceBearerToken"],"Resource":"*"},
      {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion"],"Resource":"arn:aws:s3:::'"$S3_BUCKET"'/*"},
      {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}
    ]
  }'

# Create or update CodeBuild project
BUILDSPEC="version: 0.2
phases:
  pre_build:
    commands:
      - aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
      - aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REPO_URI
  build:
    commands:
      - docker build --build-arg APP_VERSION=$APP_VERSION -t $REPO_NAME:$TAG -f Dockerfile .
      - docker tag $REPO_NAME:$TAG $REPO_URI:$TAG
  post_build:
    commands:
      - docker push $REPO_URI:$TAG"

BUILDSPEC_JSON=$(echo "$BUILDSPEC" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")

if aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT" --region "$REGION" --query 'projects[0].name' --output text 2>/dev/null | grep -q "$CODEBUILD_PROJECT"; then
  aws codebuild update-project --name "$CODEBUILD_PROJECT" --region "$REGION" \
    --source '{"type":"S3","location":"'"$S3_BUCKET"'/build/src.zip","buildspec":'"$BUILDSPEC_JSON"'}' \
    >/dev/null
else
  aws codebuild create-project --name "$CODEBUILD_PROJECT" --region "$REGION" \
    --source '{"type":"S3","location":"'"$S3_BUCKET"'/build/src.zip","buildspec":'"$BUILDSPEC_JSON"'}' \
    --artifacts '{"type":"NO_ARTIFACTS"}' \
    --environment '{"type":"ARM_CONTAINER","image":"aws/codebuild/amazonlinux2-aarch64-standard:3.0","computeType":"BUILD_GENERAL1_SMALL","privilegedMode":true}' \
    --service-role "arn:aws:iam::${ACCOUNT_ID}:role/${CODEBUILD_ROLE}" \
    >/dev/null
fi

# Start build and wait
BUILD_ID=$(aws codebuild start-build --project-name "$CODEBUILD_PROJECT" --region "$REGION" \
  --environment-variables-override "name=APP_VERSION,value=${APP_VERSION:-dev},type=PLAINTEXT" \
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

# ===== Step 2: Deploy CloudFormation =====
echo "[2/4] Deploying CloudFormation stack..."
IMAGE_URI="$REPO_URI:$TAG"

STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$STACK_EXISTS" = "DOES_NOT_EXIST" ]; then
  aws cloudformation create-stack \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --template-body "file://$TEMPLATE" \
    --parameters "ParameterKey=ContainerImageUri,ParameterValue=$IMAGE_URI" "ParameterKey=ImagesBucketName,ParameterValue=$S3_BUCKET" \
    --capabilities CAPABILITY_IAM >/dev/null
  echo "  Creating stack..."
  aws cloudformation wait stack-create-complete --stack-name "$STACK_NAME" --region "$REGION"
else
  aws cloudformation update-stack \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --template-body "file://$TEMPLATE" \
    --parameters "ParameterKey=ContainerImageUri,ParameterValue=$IMAGE_URI" "ParameterKey=ImagesBucketName,ParameterValue=$S3_BUCKET" \
    --capabilities CAPABILITY_IAM >/dev/null 2>&1 \
    && { echo "  Updating stack..."; aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" --region "$REGION"; } \
    || echo "  No stack changes needed"
fi
echo "  Stack ready: $STACK_NAME"

# Update WS Lambda code (standalone Python, not Docker)
WS_FUNC="${STACK_NAME}-ws-handler"
WS_ZIP="/tmp/agentpeek-ws-lambda.zip"
(cd src && zip -q "$WS_ZIP" bridge_ws.py)
aws lambda update-function-code --function-name "$WS_FUNC" --zip-file "fileb://$WS_ZIP" --region "$REGION" >/dev/null 2>&1 \
  && echo "  WS Lambda updated" \
  || echo "  WS Lambda update skipped (may not exist yet)"

# Force update REST Lambda to latest Docker image
REST_FUNC=$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id APIHandler --region "$REGION" \
  --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null)
if [ -n "$REST_FUNC" ]; then
  aws lambda update-function-code --function-name "$REST_FUNC" --image-uri "$IMAGE_URI" --region "$REGION" >/dev/null 2>&1 \
    && echo "  REST Lambda updated" \
    || echo "  REST Lambda update skipped"
fi

# ===== Step 3: Upload bridge install package =====
echo "[3/4] Uploading bridge package..."
BRIDGE_DIR="$SCRIPT_DIR/../bridge"
BRIDGE_TAR="/tmp/agentpeek-bridge.tar.gz"
(cd "$BRIDGE_DIR" && tar czf "$BRIDGE_TAR" *.mjs package.json)
aws s3 cp "$BRIDGE_TAR" "s3://${S3_BUCKET}/install/bridge.tar.gz" --region "$REGION" --quiet
rm -f "$BRIDGE_TAR"
echo "  Uploaded to s3://${S3_BUCKET}/install/bridge.tar.gz"

# ===== Step 4: Output =====
echo "[4/4] Getting connection info..."
echo ""

API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`APIURL`].OutputValue' --output text)

CF_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontURL`].OutputValue' --output text 2>/dev/null || echo "")

KEY_ID=$(aws apigateway get-api-keys --region "$REGION" \
  --query "items[?name=='${STACK_NAME}-api-key'].id" --output text)
API_KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --region "$REGION" \
  --query 'value' --output text)

if [ -n "$CF_URL" ] && [ "$CF_URL" != "None" ]; then
  SETUP_URL="$CF_URL/setup.html?key=$API_KEY"
else
  SETUP_URL="$API_URL/setup.html?key=$API_KEY"
fi

echo "================================================"
echo "  Deploy complete!"
echo "================================================"
echo ""
echo "  Open this URL to get started:"
echo "    $SETUP_URL"
echo ""
echo "================================================"
