#!/bin/bash
# The mainland-China entry relay (docs/v2-cn-relay.md): a TCP passthrough to Cloudflare for the listed API hosts.
# TLS is not terminated; the relay reads only the SNI to refuse every other name. Debian 12, run as root;
# safe to run again. Usage: [REPORT_URL=… REPORT_KEY=… RELAY_NAME=…] setup.sh <host>[,<host>...] [upstream]
# With REPORT_URL, relay-guard reports its traffic every 5 minutes to the monitor (summary figures only, no addresses).
set -euo pipefail
HOSTS=${1:?allowed SNI hostnames, comma-separated}
UPSTREAM=${2:-api.agentbaton.app} # any proxied hostname in the zone: it only resolves to Cloudflare's addresses

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx libnginx-mod-stream nftables unattended-upgrades

ALLOW=$(tr ',' '\n' <<<"$HOSTS" | sed 's/.*/    & 1;/')
cat >/etc/nginx/nginx.conf <<CONF
load_module modules/ngx_stream_module.so;
user www-data;
worker_processes auto;
worker_rlimit_nofile 65536;
pid /run/nginx.pid;
events { worker_connections 16384; }

stream {
  resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
  map \$ssl_preread_server_name \$allowed {
$ALLOW
    default 0;
  }
  map \$allowed \$target { 1 $UPSTREAM:443; default 127.0.0.1:9; }
  access_log off; # no record of who connected
  limit_conn_zone \$binary_remote_addr zone=perip:10m;

  server {
    listen 443 reuseport;
    listen [::]:443 reuseport;
    ssl_preread on;
    proxy_pass \$target;
    proxy_connect_timeout 5s;
    proxy_timeout 1h; # idle App and Bridge sockets ping well within this
    limit_conn perip 100;
    proxy_upload_rate 1m;
    proxy_download_rate 1m;
  }
}
CONF

# Per address (IPv6: per /64): new connections rate-limited, bytes both ways counted for a day; blocked addresses dropped.
cat >/etc/nftables.conf <<'NFT'
#!/usr/sbin/nft -f
flush ruleset
table inet relay {
  set new4 { type ipv4_addr; flags dynamic, timeout; timeout 1m; }
  set new6 { type ipv6_addr; flags dynamic, timeout; timeout 1m; }
  set use4 { type ipv4_addr; flags dynamic, timeout; timeout 1d; size 262144; }
  set use6 { type ipv6_addr; flags dynamic, timeout; timeout 1d; size 262144; }
  set block4 { type ipv4_addr; flags timeout; }
  set block6 { type ipv6_addr; flags interval, timeout; }
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport 443 ip saddr @block4 drop
    tcp dport 443 ip6 saddr @block6 drop
    tcp dport 443 ct state new update @new4 { ip saddr limit rate over 20/second burst 40 packets } drop
    tcp dport 443 ct state new update @new6 { ip6 saddr and ffff:ffff:ffff:ffff:: limit rate over 20/second burst 40 packets } drop
    tcp dport 443 add @use4 { ip saddr counter }
    tcp dport 443 add @use6 { ip6 saddr and ffff:ffff:ffff:ffff:: counter }
  }
  chain output {
    type filter hook output priority 0; policy accept;
    tcp sport 443 add @use4 { ip daddr counter }
    tcp sport 443 add @use6 { ip6 daddr and ffff:ffff:ffff:ffff:: counter }
  }
}
NFT

# Every 5 minutes: an address past 1 GiB in its day is blocked for a day; past CAP bytes this month (both directions, as
# Lightsail counts its allowance) relaying stops until the next month. Clients then use the API host directly.
cat >/usr/local/bin/relay-guard <<'PY'
#!/usr/bin/python3
import glob, json, os, subprocess, time
DAILY, CAP = int(os.environ.get('DAILY', 1 << 30)), int(os.environ.get('CAP', 1_800_000_000_000))
STATE = '/var/lib/relay-guard.json'
nft = lambda *a: subprocess.run(['nft', *a], check=True, capture_output=True, text=True).stdout

addrs = 0  # addresses (IPv6: /64s) seen in the last 24 h
for name, block, prefix in (('use4', 'block4', ''), ('use6', 'block6', '/64')):
    for item in json.loads(nft('-j', 'list', 'set', 'inet', 'relay', name))['nftables']:
        for e in item.get('set', {}).get('elem', []):
            e = e.get('elem', {}) if isinstance(e, dict) else {}
            addrs += bool(e)
            if e.get('counter', {}).get('bytes', 0) > DAILY:
                nft('add', 'element', 'inet', 'relay', block, '{ %s%s timeout 1d }' % (e['val'], prefix))

raw = sum(int(open(f).read()) for d in glob.glob('/sys/class/net/*') if not d.endswith('/lo')
          for f in (d + '/statistics/rx_bytes', d + '/statistics/tx_bytes'))
month = time.strftime('%Y-%m', time.gmtime())
try: state = json.load(open(STATE))
except (OSError, ValueError): state = {}
if state.get('month') != month:
    state = {'month': month, 'total': 0, 'raw': raw, 'stopped': state.get('stopped', False)}
delta = raw - state['raw'] if raw >= state['raw'] else raw  # counters restart at boot
state['total'] += delta
state['raw'] = raw
day = time.strftime('%Y-%m-%d', time.gmtime())
if state.get('day') != day: state['day'], state['dayTotal'] = day, 0
state['dayTotal'] += delta
if state['total'] > CAP:  # every run: a reboot starts nginx again
    subprocess.run(['systemctl', 'stop', 'nginx'])
    if not state.get('stopped'): print('monthly cap reached: relaying stopped until', month, 'ends')
    state['stopped'] = True
elif state.get('stopped'):  # a new month (or a higher cap)
    subprocess.run(['systemctl', 'start', 'nginx'])
    state['stopped'] = False
json.dump(state, open(STATE, 'w'))
if os.environ.get('REPORT_URL'):
    import urllib.request
    body = json.dumps({'name': os.environ.get('RELAY_NAME', ''), 'day': day, 'dayBytes': state['dayTotal'], 'month': month,
                       'monthBytes': state['total'], 'cap': CAP, 'stopped': bool(state.get('stopped')), 'addrs': addrs}).encode()
    headers = {'content-type': 'application/json', 'authorization': 'Bearer ' + os.environ.get('REPORT_KEY', ''),
               'user-agent': 'baton-relay-guard'}  # Cloudflare refuses Python-urllib's (error 1010)
    try: urllib.request.urlopen(urllib.request.Request(os.environ['REPORT_URL'], body, headers), timeout=10)
    except Exception as error: print('report failed:', error)
PY
if [ -n "${REPORT_URL:-}" ]; then # a rerun keeps the relay's name
  RELAY_NAME=${RELAY_NAME:-$(sed -n 's/^RELAY_NAME=//p' /etc/relay-guard.env 2>/dev/null || true)}
  (umask 077; printf 'REPORT_URL=%s\nREPORT_KEY=%s\nRELAY_NAME=%s\n' "$REPORT_URL" "${REPORT_KEY:-}" "${RELAY_NAME:-$(hostname)}" >/etc/relay-guard.env)
fi
chmod 755 /usr/local/bin/relay-guard
printf '[Service]\nType=oneshot\nEnvironmentFile=-/etc/relay-guard.env\nExecStart=/usr/local/bin/relay-guard\n' >/etc/systemd/system/relay-guard.service
printf '[Timer]\nOnCalendar=*:0/5\nPersistent=true\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/relay-guard.timer

# Security updates install daily; one that needs a reboot (a kernel) takes effect at 03:02 Beijing (between relay-guard runs); clients use the API host meanwhile.
printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "19:02";\n' >/etc/apt/apt.conf.d/52relay-reboot
mkdir -p /etc/systemd/system/nginx.service.d
printf '[Service]\nLimitNOFILE=65536\n' >/etc/systemd/system/nginx.service.d/limits.conf
printf 'net.core.somaxconn = 4096\nnet.ipv4.tcp_fastopen = 3\n' >/etc/sysctl.d/90-relay.conf
sysctl -q --system
nginx -t
systemctl daemon-reload
systemctl enable -q --now nftables relay-guard.timer
systemctl restart nftables
systemctl enable -q nginx
systemctl restart nginx
echo "relay ready: ${HOSTS} -> ${UPSTREAM}"
