#!/bin/bash
# Creates one relay on Lightsail (docs/v2-cn-relay.md): instance, static IP, firewall (443; SSH only from ADMIN_CIDR),
# configured at first boot by setup.sh. Usage: create.sh <name> <host>[,<host>...] [admin-cidr]
# Env: AWS_PROFILE / AWS_REGION (default ap-northeast-1), BUNDLE (default micro_3_0), ALERT_EMAIL.
set -euo pipefail
NAME=${1:?instance name}
HOSTS=${2:?allowed SNI hostnames, comma-separated}
ADMIN_CIDR=${3:-}
export AWS_REGION=${AWS_REGION:-ap-northeast-1}
DIR=$(cd "$(dirname "$0")" && pwd)

SCRIPT=$(printf '#!/bin/bash\ncat > /root/relay-setup.sh <<'"'"'EOF'"'"'\n%s\nEOF\nbash /root/relay-setup.sh %q > /var/log/relay-setup.log 2>&1\n' "$(cat "$DIR/setup.sh")" "$HOSTS")
aws lightsail create-instances --instance-names "$NAME" --availability-zone "${AWS_REGION}a" --blueprint-id debian_12 \
  --bundle-id "${BUNDLE:-micro_3_0}" --ip-address-type dualstack --user-data "$SCRIPT" --tags key=role,value=baton-relay >/dev/null
until [ "$(aws lightsail get-instance-state --instance-name "$NAME" --query state.name --output text)" = running ]; do sleep 5; done

aws lightsail allocate-static-ip --static-ip-name "$NAME-ip" >/dev/null
aws lightsail attach-static-ip --static-ip-name "$NAME-ip" --instance-name "$NAME" >/dev/null
PORTS='fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0'
[ -n "$ADMIN_CIDR" ] && PORTS="$PORTS fromPort=22,toPort=22,protocol=tcp,cidrs=$ADMIN_CIDR"
# shellcheck disable=SC2086
aws lightsail put-instance-public-ports --instance-name "$NAME" --port-infos $PORTS >/dev/null
# ALERT_EMAIL: mail when NetworkOut stays above 69 MB per 5 minutes for 2 hours, the pace of 1.2 TB a month both ways
# (60% of micro's allowance). Lightsail mails a confirmation link for a new address first.
if [ -n "${ALERT_EMAIL:-}" ]; then
  aws lightsail create-contact-method --protocol Email --contact-endpoint "$ALERT_EMAIL" >/dev/null 2>&1 || true
  aws lightsail put-alarm --alarm-name "$NAME-traffic" --metric-name NetworkOut --monitored-resource-name "$NAME" \
    --comparison-operator GreaterThanOrEqualToThreshold --threshold 69000000 --evaluation-periods 24 --datapoints-to-alarm 24 \
    --treat-missing-data notBreaching --contact-protocols Email --notification-triggers ALARM >/dev/null
fi
aws lightsail get-instance --instance-name "$NAME" --query 'instance.[publicIpAddress,ipv6Addresses[0]]' --output text
