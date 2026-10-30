#!/bin/bash
# Deploy the shared APNs relay into its own AWS account (see docs/mobile-notifications.md).
#
# Usage:
#   AWS_PROFILE=<relay-account> relay/deploy.sh [--region ap-northeast-1] [--alert-email you@example.com]
set -euo pipefail
cd "$(dirname "$0")"

REGION=ap-northeast-1
STACK=BatonPushRelay
EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --alert-email) EMAIL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file template.json \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides "AlertEmail=$EMAIL"
output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

# The template only holds a stub; the relay code is uploaded here, without an S3 bucket.
ZIP="$(mktemp -d)/relay.zip"
zip -qj "$ZIP" apns_relay.mjs
aws lambda update-function-code --region "$REGION" --function-name "$(output FunctionName)" \
  --zip-file "fileb://$ZIP" >/dev/null
aws lambda wait function-updated --region "$REGION" --function-name "$(output FunctionName)"
rm -f "$ZIP"
echo "Push relay URL: $(output RelayUrl)"
