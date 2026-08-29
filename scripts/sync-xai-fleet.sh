#!/usr/bin/env bash
# Push Mac dual auth (and optionally force-refresh first) to fleet replicas.
# Usage:
#   ./scripts/sync-xai-fleet.sh           # push current files
#   ./scripts/sync-xai-fleet.sh --refresh # refresh xai-auth via token endpoint if near expiry, then push
set -euo pipefail

AGENT_DIR="${HOME}/.pi/agent"
PI_AUTH="${AGENT_DIR}/auth.json"
GROK_AUTH="${HOME}/.grok/auth.json"
FLEET_CFG="${AGENT_DIR}/xai-fleet.json"

if [[ ! -f "$FLEET_CFG" ]]; then
  echo "missing $FLEET_CFG" >&2
  exit 1
fi

if [[ "${1:-}" == "--refresh" ]]; then
  python3 - <<'PY'
import json, time, urllib.parse, urllib.request
from pathlib import Path
pi_path = Path.home()/".pi"/"agent"/"auth.json"
data = json.loads(pi_path.read_text())
xa = data.get("xai-auth") or {}
refresh = xa.get("refresh")
exp = xa.get("expires") or 0
now_ms = int(time.time()*1000)
# refresh if missing exp or within 30 min of expiry
if not refresh:
    raise SystemExit("no refresh token in pi auth")
if exp and exp - now_ms > 30*60*1000:
    print("access still fresh; skip token refresh")
else:
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
    }).encode()
    req = urllib.request.Request(
        xa.get("tokenEndpoint") or "https://auth.x.ai/oauth2/token",
        data=body,
        headers={"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        tok = json.loads(resp.read().decode())
    xa["access"] = tok["access_token"]
    if tok.get("refresh_token"):
        xa["refresh"] = tok["refresh_token"]
    xa["expires"] = now_ms + int(tok.get("expires_in") or 3600)*1000 - 120_000
    data["xai-auth"] = xa
    pi_path.write_text(json.dumps(data, indent=2) + "\n")
    # mirror grok
    grok_path = Path.home()/".grok"/"auth.json"
    grok_path.parent.mkdir(parents=True, exist_ok=True)
    grok = {}
    if grok_path.exists():
        try:
            grok = json.loads(grok_path.read_text())
        except Exception:
            grok = {}
    key = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"
    entry = dict(grok.get(key) or {})
    entry["key"] = xa["access"]
    entry["refresh_token"] = xa["refresh"]
    entry["expires_at"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(xa["expires"]/1000)) + "Z"
    grok[key] = entry
    grok_path.write_text(json.dumps(grok, indent=2) + "\n")
    print("refreshed xai-auth")
PY
fi

python3 - <<'PY'
import json, subprocess, sys
from pathlib import Path
cfg = json.loads((Path.home()/".pi"/"agent"/"xai-fleet.json").read_text())
if cfg.get("role") != "source":
    print("not a source host; nothing to push", file=sys.stderr)
    sys.exit(1)
hosts = cfg.get("pushTo") or []
ssh_opts = ["-o","BatchMode=yes","-o","ConnectTimeout=5","-o","StrictHostKeyChecking=accept-new"]
pi = Path.home()/".pi"/"agent"/"auth.json"
grok = Path.home()/".grok"/"auth.json"
if not pi.exists():
    print("missing pi auth", file=sys.stderr); sys.exit(1)
ok=fail=0
for host in hosts:
    try:
        subprocess.run(["ssh", *ssh_opts, host, "mkdir -p ~/.pi/agent ~/.grok && chmod 700 ~/.pi/agent ~/.grok"], check=True, timeout=30)
        subprocess.run(["scp", *ssh_opts, str(pi), f"{host}:~/.pi/agent/auth.json"], check=True, timeout=30)
        if grok.exists():
            subprocess.run(["scp", *ssh_opts, str(grok), f"{host}:~/.grok/auth.json"], check=True, timeout=30)
        subprocess.run(["ssh", *ssh_opts, host, "chmod 600 ~/.pi/agent/auth.json; [ -f ~/.grok/auth.json ] && chmod 600 ~/.grok/auth.json || true"], check=True, timeout=30)
        print(f"OK {host}")
        ok += 1
    except Exception as e:
        print(f"FAIL {host}: {e}", file=sys.stderr)
        fail += 1
print(f"pushed ok={ok} fail={fail}")
sys.exit(1 if fail and not ok else 0)
PY
