#!/bin/bash
# AgentPeek Server — one-command deploy
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/agentpeek/main/server/install.sh | bash
#   curl ... | bash -s -- --region us-west-2
#   ./install.sh                                 # from cloned repo
#   ./install.sh --region us-west-2
#   ./install.sh --region us-west-2 --stack MyStack
#   ./install.sh --region us-west-2 --profile myprofile

main() {
set -euo pipefail

# Colors (only when stdout is a terminal)
if [ -t 1 ]; then
  C_GREEN=$'\033[1;32m'; C_RED=$'\033[1;31m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_BOLD=""; C_DIM=""; C_RESET=""
fi
LINE="=================================================================="

# On any error, print the failing line + command
trap 'rc=$?; echo ""; echo "${C_RED}ERROR: install.sh failed at line $LINENO (exit $rc): $BASH_COMMAND${C_RESET}" >&2; exit $rc' ERR

# ===== Self-bootstrap: if not inside the repo, clone it first =====
REPO_URL="https://github.com/zhu-xiaowei/agentpeek.git"
SELF_MARKER="server/template/AgentPeek.template"

if [ ! -f "$(dirname "${BASH_SOURCE[0]:-$0}")/../$SELF_MARKER" ] 2>/dev/null; then
  if ! command -v git >/dev/null 2>&1; then
    echo "${C_RED}ERROR: git is required but not installed.${C_RESET}"
    case "$(uname -s)" in
      Darwin) echo "  Install: ${C_BOLD}xcode-select --install${C_RESET}" ;;
      Linux)  echo "  Install: ${C_BOLD}sudo apt install git${C_RESET} or ${C_BOLD}sudo yum install git${C_RESET}" ;;
    esac
    exit 1
  fi

  if ! command -v aws >/dev/null 2>&1; then
    echo "${C_RED}ERROR: AWS CLI is required but not installed.${C_RESET}"
    echo "  Install: ${C_BOLD}https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html${C_RESET}"
    exit 1
  fi

  CLONE_DIR=$(mktemp -d)
  trap 'rm -rf "$CLONE_DIR"' EXIT
  echo "Cloning agentpeek..."
  if ! git clone --depth 1 --quiet "$REPO_URL" "$CLONE_DIR/agentpeek"; then
    echo "${C_RED}ERROR: Failed to clone repository${C_RESET}"
    exit 1
  fi
  set +e
  bash "$CLONE_DIR/agentpeek/server/install.sh" "$@"
  exit $?
fi

# Async polling: spinner ticks every 200ms; AWS calls run in background and write .ready files.
SPINNER=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

# Poll CloudFormation stack — smooth spinner, hide counter until resources are visible.
wait_stack() {
  local target_status="$1"
  local cache="$(mktemp -t apeek-cfn.XXXX)"
  local cfn_text="" busy=false tick=0 spin_idx=0 spin_char
  local rc=0

  start_poll() {
    busy=true
    (
      set +e
      local s resources total done_count latest
      s=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
        --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "")
      resources=$(aws cloudformation list-stack-resources --stack-name "$STACK_NAME" --region "$REGION" \
        --query 'StackResourceSummaries[*].[LogicalResourceId,ResourceStatus]' --output text 2>/dev/null || echo "")
      local progress=""
      if [ -n "$resources" ]; then
        total=$(echo "$resources" | wc -l | tr -d ' ')
        done_count=$(echo "$resources" | grep -cE 'CREATE_COMPLETE|UPDATE_COMPLETE' 2>/dev/null || echo 0)
        latest=$(echo "$resources" | grep -E 'IN_PROGRESS' | head -1 | awk '{print $1}')
        [ ${#latest} -gt 30 ] && latest="${latest:0:27}..."
        if [ -n "$latest" ]; then
          progress="$done_count/$total ($latest)"
        else
          progress="$done_count/$total"
        fi
      fi
      printf "%s\n%s" "$s" "$progress" > "$cache.tmp"
      mv "$cache.tmp" "$cache.ready"
    ) &
  }

  start_poll
  while true; do
    if [ -f "$cache.ready" ]; then
      mv "$cache.ready" "$cache"
      local status_line progress_line
      status_line=$(head -1 "$cache")
      progress_line=$(tail -n +2 "$cache")
      busy=false
      tick=0
      case "$status_line" in
        "$target_status")     rc=0; break ;;
        *FAILED*|*ROLLBACK*)  rc=1; break ;;
      esac
      cfn_text="$progress_line"
    fi

    spin_char="${SPINNER[$spin_idx]}"
    spin_idx=$(( (spin_idx + 1) % ${#SPINNER[@]} ))
    if [ -n "$cfn_text" ]; then
      printf "\r\033[K  %s %s" "$spin_char" "$cfn_text"
    else
      printf "\r\033[K  %s" "$spin_char"
    fi

    tick=$((tick + 1))
    if ! $busy && [ $tick -ge 25 ]; then
      start_poll
    fi
    sleep 0.2
  done
  printf "\r\033[K"
  rm -f "$cache" "$cache.tmp" "$cache.ready"
  return $rc
}

# ===== Parse args =====
REGION=""
STACK_NAME="AgentPeek"
PROFILE=""
REPO_NAME="agentpeek-api"
TAG="latest"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region)  REGION="$2"; shift 2 ;;
    --stack)   STACK_NAME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Apply profile to all subsequent aws calls
if [ -n "$PROFILE" ]; then
  export AWS_PROFILE="$PROFILE"
fi

# Resolve region: --region > $AWS_REGION > aws configure > us-east-1
if [ -z "$REGION" ]; then
  REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo '')}"
  REGION="${REGION:-us-east-1}"
fi

# ===== Prerequisites =====
command -v aws >/dev/null 2>&1 || { echo "${C_RED}ERROR: AWS CLI required${C_RESET}"; exit 1; }

STS_OUT=$(aws sts get-caller-identity --region "$REGION" --output text --query Account 2>&1) || {
  echo "${C_RED}ERROR: AWS credentials are not usable${PROFILE:+ for profile '$PROFILE'}.${C_RESET}" >&2
  echo "$STS_OUT" | sed 's/^/  /' >&2
  if echo "$STS_OUT" | grep -qE "ExpiredToken|InvalidClientTokenId|SignatureDoesNotMatch|token.*expired"; then
    echo "  Hint: refresh credentials (${C_BOLD}aws sso login${C_RESET} or update temporary keys) and retry." >&2
  else
    echo "  Hint: run ${C_BOLD}aws configure${C_RESET} to set up credentials." >&2
  fi
  exit 1
}
ACCOUNT_ID="$STS_OUT"

echo "Deploying AgentPeek — region=$REGION, stack=$STACK_NAME, account=$ACCOUNT_ID"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
TEMPLATE="$SCRIPT_DIR/template/AgentPeek.template"
WEB_DIR="$SCRIPT_DIR/../web"
ROOT_DIR="$SCRIPT_DIR/.."
REPO_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}"
S3_BUCKET="$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]')-${REGION}-images-${ACCOUNT_ID}"
CODEBUILD_PROJECT="${STACK_NAME}-build"
CODEBUILD_ROLE="${STACK_NAME}-codebuild-role"

# Ensure S3 bucket exists (shared for build artifacts, bridge package, images)
aws s3 mb "s3://${S3_BUCKET}" --region "$REGION" >/dev/null 2>&1 || true

# App version: semantic from version.json + short git hash (e.g. "0.2.0-92144c3").
# Git hash auto-bumps every commit — bridge auto-update triggers on each redeploy.
VERSION_FILE="$ROOT_DIR/version.json"
SEMANTIC="dev"
if [ -f "$VERSION_FILE" ]; then
  SEMANTIC=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['version'])" 2>/dev/null || echo "dev")
fi
GIT_HASH=$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "")
if [ -n "$GIT_HASH" ]; then
  APP_VERSION="${SEMANTIC}-${GIT_HASH}"
else
  APP_VERSION="$SEMANTIC"
fi

# ===== Step 1: Build server Docker image =====
echo "[1/4] Building server Docker image (version=$APP_VERSION)..."

aws ecr create-repository --repository-name "$REPO_NAME" --region "$REGION" >/dev/null 2>&1 || true

# Stage build context: server/src + web + root frontend files. Vite build runs inside Dockerfile.
BUILD_CTX=$(mktemp -d)
trap 'rm -rf "$BUILD_CTX"' EXIT
cp -r "$SRC_DIR"/. "$BUILD_CTX/"
rm -f "$BUILD_CTX/test_api.py" 2>/dev/null || true
cp -r "$WEB_DIR" "$BUILD_CTX/web"
rm -f "$BUILD_CTX/web/test_api.py" 2>/dev/null || true
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$ROOT_DIR/vite.config.js" "$BUILD_CTX/"

SRC_ZIP="/tmp/agentpeek-src-$$.zip"
(cd "$BUILD_CTX" && zip -qr "$SRC_ZIP" .)
aws s3 cp "$SRC_ZIP" "s3://${S3_BUCKET}/build/src.zip" --region "$REGION" --only-show-errors
rm -f "$SRC_ZIP"

# CodeBuild role (create if missing)
if ! aws iam get-role --role-name "$CODEBUILD_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$CODEBUILD_ROLE" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' >/dev/null
fi
aws iam put-role-policy --role-name "$CODEBUILD_ROLE" --policy-name build-policy \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[
      {"Effect":"Allow","Action":["ecr:*"],"Resource":"*"},
      {"Effect":"Allow","Action":["ecr-public:GetAuthorizationToken","sts:GetServiceBearerToken"],"Resource":"*"},
      {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion"],"Resource":"arn:aws:s3:::'"$S3_BUCKET"'/*"},
      {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}
    ]
  }' >/dev/null

# Buildspec embedded into project (REPO_NAME / TAG / APP_VERSION passed as env overrides)
BUILDSPEC='version: 0.2
phases:
  pre_build:
    commands:
      - REPO_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com/${REPO_NAME}"
      - aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPO_URI
  build:
    commands:
      - docker build --build-arg APP_VERSION=$APP_VERSION -t $REPO_NAME:$TAG -f Dockerfile .
      - docker tag $REPO_NAME:$TAG $REPO_URI:$TAG
  post_build:
    commands:
      - docker push $REPO_URI:$TAG'
BUILDSPEC_JSON=$(echo "$BUILDSPEC" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")

PROJECT_EXISTS=$(aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT" --region "$REGION" \
  --query 'projects[0].name' --output text 2>/dev/null | grep -q "$CODEBUILD_PROJECT" && echo true || echo false)

# Retry create/update until CodeBuild sees the IAM role (propagation can take 1-3 min for new roles)
for i in $(seq 1 36); do
  if [ "$PROJECT_EXISTS" = "true" ]; then
    ERR=$(aws codebuild update-project --name "$CODEBUILD_PROJECT" --region "$REGION" \
      --source '{"type":"S3","location":"'"$S3_BUCKET"'/build/src.zip","buildspec":'"$BUILDSPEC_JSON"'}' \
      --service-role "arn:aws:iam::${ACCOUNT_ID}:role/${CODEBUILD_ROLE}" 2>&1 >/dev/null) && break
  else
    ERR=$(aws codebuild create-project --name "$CODEBUILD_PROJECT" --region "$REGION" \
      --source '{"type":"S3","location":"'"$S3_BUCKET"'/build/src.zip","buildspec":'"$BUILDSPEC_JSON"'}' \
      --artifacts '{"type":"NO_ARTIFACTS"}' \
      --environment '{"type":"ARM_CONTAINER","image":"aws/codebuild/amazonlinux2-aarch64-standard:3.0","computeType":"BUILD_GENERAL1_SMALL","privilegedMode":true}' \
      --service-role "arn:aws:iam::${ACCOUNT_ID}:role/${CODEBUILD_ROLE}" 2>&1 >/dev/null) && break
  fi
  if echo "$ERR" | grep -qE "InvalidInputException|not authorized|cannot be assumed"; then
    sleep 5
  else
    echo "$ERR" >&2
    exit 1
  fi
done

BUILD_ID=$(aws codebuild start-build --project-name "$CODEBUILD_PROJECT" --region "$REGION" \
  --environment-variables-override \
    "name=ACCOUNT_ID,value=${ACCOUNT_ID},type=PLAINTEXT" \
    "name=REPO_NAME,value=${REPO_NAME},type=PLAINTEXT" \
    "name=TAG,value=${TAG},type=PLAINTEXT" \
    "name=APP_VERSION,value=${APP_VERSION},type=PLAINTEXT" \
  --query 'build.id' --output text)

# Poll CodeBuild phases asynchronously — single-line spinner that updates the phase name in place.
CB_CACHE=$(mktemp -t apeek-cb.XXXX)
CB_BUSY=false
CB_TICK=0
SPIN_IDX=0
STATUS="IN_PROGRESS"
CURRENT_PHASE=""

start_cb_poll() {
  CB_BUSY=true
  (
    set +e
    s=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
      --query 'builds[0].buildStatus' --output text 2>/dev/null)
    phases=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
      --query 'builds[0].phases[*].[phaseType,phaseStatus]' --output text 2>/dev/null)
    printf "%s\n%s" "$s" "$phases" > "$CB_CACHE.tmp"
    mv "$CB_CACHE.tmp" "$CB_CACHE.ready"
  ) &
}

start_cb_poll
while true; do
  if [ -f "$CB_CACHE.ready" ]; then
    mv "$CB_CACHE.ready" "$CB_CACHE"
    STATUS=$(head -1 "$CB_CACHE")
    PHASES=$(tail -n +2 "$CB_CACHE")
    CURRENT_PHASE=""
    while IFS=$'\t' read -r name pstatus; do
      case "$name" in
        SUBMITTED|PROVISIONING|DOWNLOAD_SOURCE|INSTALL|PRE_BUILD|BUILD|POST_BUILD|FINALIZING)
          if [ -z "$pstatus" ] || [ "$pstatus" = "None" ]; then
            CURRENT_PHASE="$name"
          fi ;;
      esac
    done <<< "$PHASES"
    CB_BUSY=false
    CB_TICK=0
    [ "$STATUS" != "IN_PROGRESS" ] && break
  fi

  SPIN_CHAR="${SPINNER[$SPIN_IDX]}"
  SPIN_IDX=$(( (SPIN_IDX + 1) % ${#SPINNER[@]} ))
  if [ -n "$CURRENT_PHASE" ]; then
    printf "\r\033[K  %s %s..." "$SPIN_CHAR" "$CURRENT_PHASE"
  else
    printf "\r\033[K  %s" "$SPIN_CHAR"
  fi

  CB_TICK=$((CB_TICK + 1))
  if ! $CB_BUSY && [ $CB_TICK -ge 25 ]; then
    start_cb_poll
  fi
  sleep 0.2
done
printf "\r\033[K"
rm -f "$CB_CACHE" "$CB_CACHE.tmp" "$CB_CACHE.ready"

if [ "$STATUS" != "SUCCEEDED" ]; then
  echo ""
  echo "${C_RED}ERROR: CodeBuild finished with status: $STATUS${C_RESET}"
  aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].phases[?phaseStatus!=`SUCCEEDED` && phaseStatus!=null].[phaseType,phaseStatus,contexts[0].message]' \
    --output text 2>/dev/null | sed 's/^/  /'
  LOG_GROUP=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].logs.groupName' --output text 2>/dev/null || echo "")
  LOG_STREAM=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].logs.streamName' --output text 2>/dev/null || echo "")
  if [ -n "$LOG_GROUP" ] && [ "$LOG_GROUP" != "None" ] && [ -n "$LOG_STREAM" ] && [ "$LOG_STREAM" != "None" ]; then
    echo ""
    echo "  --- Last log lines ---"
    aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$LOG_STREAM" \
      --region "$REGION" --limit 30 --query 'events[*].message' --output text 2>/dev/null | tail -30 | sed 's/^/  /'
  fi
  echo ""
  echo "  Full logs: https://console.aws.amazon.com/codesuite/codebuild/projects/${CODEBUILD_PROJECT}/build/${BUILD_ID}"
  exit 1
fi

# ===== Step 2: Deploy CloudFormation =====
echo "[2/4] Deploying CloudFormation stack..."
# Use image digest (immutable) so CFN detects parameter changes and updates the
# Lambda function automatically. With a mutable :tag the parameter string never
# changes between deploys and CFN treats the Lambda as unchanged, leaving it
# pinned to the previous image digest.
IMAGE_DIGEST=$(aws ecr describe-images --repository-name "$REPO_NAME" --region "$REGION" \
  --image-ids "imageTag=$TAG" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)
if [ -z "$IMAGE_DIGEST" ] || [ "$IMAGE_DIGEST" = "None" ]; then
  echo "${C_RED}ERROR: Failed to resolve image digest for ${REPO_NAME}:${TAG}${C_RESET}" >&2
  exit 1
fi
IMAGE_URI="${REPO_URI}@${IMAGE_DIGEST}"

cfn_dump_failure() {
  echo ""
  echo "${C_RED}ERROR: CloudFormation stack operation failed. Failed resources:${C_RESET}"
  aws cloudformation describe-stack-events --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'StackEvents[?contains(ResourceStatus,`FAILED`) || contains(ResourceStatus,`ROLLBACK`)].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]' \
    --output text 2>/dev/null | head -20 | sed 's/^/  /'
  exit 1
}

STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$STACK_STATUS" = "DOES_NOT_EXIST" ]; then
  aws cloudformation create-stack \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --template-body "file://$TEMPLATE" \
    --parameters \
      "ParameterKey=ContainerImageUri,ParameterValue=$IMAGE_URI" \
      "ParameterKey=ImagesBucketName,ParameterValue=$S3_BUCKET" \
    --capabilities CAPABILITY_IAM >/dev/null
  wait_stack "CREATE_COMPLETE" || cfn_dump_failure
else
  if aws cloudformation update-stack \
       --stack-name "$STACK_NAME" --region "$REGION" \
       --template-body "file://$TEMPLATE" \
       --parameters \
         "ParameterKey=ContainerImageUri,ParameterValue=$IMAGE_URI" \
         "ParameterKey=ImagesBucketName,ParameterValue=$S3_BUCKET" \
       --capabilities CAPABILITY_IAM >/dev/null 2>&1; then
    wait_stack "UPDATE_COMPLETE" || cfn_dump_failure
  fi
fi
echo "  ${C_GREEN}✓${C_RESET} Stack ready"

# Update WS Lambda code (standalone Python zip — CFN template stores a placeholder
# so the real handler is pushed out-of-band each deploy).
WS_FUNC="${STACK_NAME}-ws-handler"
WS_ZIP="/tmp/agentpeek-ws-lambda.zip"
(cd "$SRC_DIR" && zip -q "$WS_ZIP" bridge_ws.py)
aws lambda update-function-code --function-name "$WS_FUNC" --zip-file "fileb://$WS_ZIP" --region "$REGION" >/dev/null 2>&1 || true
rm -f "$WS_ZIP"

# ===== Step 3: Upload bridge install package =====
echo "[3/4] Uploading bridge package..."
BRIDGE_DIR="$ROOT_DIR/bridge"
BRIDGE_TAR="/tmp/agentpeek-bridge.tar.gz"
(cd "$BRIDGE_DIR" && tar czf "$BRIDGE_TAR" *.mjs package.json)
aws s3 cp "$BRIDGE_TAR" "s3://${S3_BUCKET}/install/bridge.tar.gz" --region "$REGION" --only-show-errors
rm -f "$BRIDGE_TAR"

# ===== Step 4: Fetch outputs =====
echo "[4/4] Fetching outputs..."

API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`APIURL`].OutputValue' --output text)

CF_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontURL`].OutputValue' --output text 2>/dev/null || echo "")

KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiKeyId`].OutputValue' --output text 2>/dev/null || echo "")
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
  KEY_ID=$(aws apigateway get-api-keys --region "$REGION" \
    --query "items[?name=='${STACK_NAME}-api-key'].id | [0]" --output text)
fi
API_KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --region "$REGION" \
  --query 'value' --output text)

if [ -n "$CF_URL" ] && [ "$CF_URL" != "None" ]; then
  BASE_URL="$CF_URL"
else
  BASE_URL="$API_URL"
fi

# Generate token (12h TTL) — exchanged on first page load for the real API key.
# Lets us print a single URL without exposing the key in console / shell history.
SYSTEM_TABLE="${STACK_NAME}-system"
TOKEN=$(openssl rand -hex 16)
TOKEN_TTL=$(($(date +%s) + 43200))
aws dynamodb put-item \
  --table-name "$SYSTEM_TABLE" --region "$REGION" \
  --item "{\"pk\":{\"S\":\"TOKEN\"},\"sk\":{\"S\":\"$TOKEN\"},\"apiKey\":{\"S\":\"$API_KEY\"},\"ttl\":{\"N\":\"$TOKEN_TTL\"}}" \
  >/dev/null

OPEN_URL="${BASE_URL}/?t=${TOKEN}"

echo ""
echo "${C_GREEN}${LINE}${C_RESET}"
echo "${C_GREEN}${C_BOLD}  ✓ Deploy successful!${C_RESET}"
echo "${C_GREEN}${LINE}${C_RESET}"
echo ""
echo "  ${C_BOLD}AgentPeek Start URL${C_RESET} ${C_DIM}(expires in 12 hours)${C_RESET}"
echo ""
echo "  ${C_BOLD}${OPEN_URL}${C_RESET}"
echo ""
echo "${C_GREEN}${LINE}${C_RESET}"

# Print scannable QR if Node.js is available (non-fatal if not)
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  QR_CACHE="$HOME/.cache/agentpeek-qr"
  echo ""
  echo "  ${C_BOLD}Or scan to open on phone:${C_RESET}"
  (
    mkdir -p "$QR_CACHE" && cd "$QR_CACHE"
    [ ! -d node_modules/qrcode-terminal ] && \
      npm install --silent --no-fund --no-audit qrcode-terminal@0.12.0 >/dev/null 2>&1
    QR_PAYLOAD="$OPEN_URL" node -e \
      "require('qrcode-terminal').generate(process.env.QR_PAYLOAD,{small:true})" \
      2>/dev/null | sed 's/^/  /'
  ) || true
fi
}

main "$@"
