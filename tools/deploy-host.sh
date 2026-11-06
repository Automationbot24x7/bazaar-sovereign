#!/usr/bin/env bash
# Update the live game on bazaar.reconscribe.com (Enhance hosting, Node.js worker process).
# Uploads the app over SSH into ~/bazaar (the private .env there is left untouched),
# then stops the running server; the host's worker supervisor starts it again with the new code.
# Usage: bash tools/deploy-host.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${DEPLOY_HOST:-bazaar_r1@190.92.174.232}
KEY=${DEPLOY_KEY:-$HOME/.ssh/bazaar_deploy}
tar czf - package.json package-lock.json server public node_modules \
  | ssh -i "$KEY" -o BatchMode=yes "$HOST" 'mkdir -p ~/bazaar/data && tar xzf - -C ~/bazaar && pkill -u "$(whoami)" -f "server/index.js" || true'
for i in $(seq 1 30); do
  curl -fsS --max-time 5 https://bazaar.reconscribe.com/healthz && { echo; echo "live"; exit 0; }
  sleep 2
done
echo "not answering yet: check the worker logs in the panel" >&2; exit 1
