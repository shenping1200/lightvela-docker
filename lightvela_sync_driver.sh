#!/usr/bin/env bash
KEY=/c/Users/Administrator/.ssh/vps_192_3_245_166
IPS="64.181.229.226 3.18.246.205 64.181.244.238 18.190.70.154 170.9.62.206 163.192.46.196 3.139.158.76 52.14.134.117"
LOGDIR=/tmp/lightvela_sync
mkdir -p "$LOGDIR"
for IP in $IPS; do
  (
    echo "===== $IP START $(date -u) ====="
    scp -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o BatchMode=yes /tmp/lightvela_update.sh ubuntu@$IP:/tmp/lightvela_update.sh 2>&1
    ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o BatchMode=yes ubuntu@$IP "sudo bash /tmp/lightvela_update.sh" 2>&1
    echo "===== $IP END $(date -u) ====="
  ) > "$LOGDIR/$IP.log" 2>&1 &
done
wait
echo "ALL DONE at $(date -u)"
