#!/usr/bin/env bash
# One-time PRIVILEGED host setup for the GitHub Actions self-hosted runner.
#   sudo bash tools/setup_runner_host.sh
#
# Installs two things, nothing else:
#   1. A systemd unit that runs the already-configured runner as user 'ghrunner'.
#   2. A SCOPED passwordless-sudo rule letting 'ghrunner' run ONLY this repo's
#      deploy script (validated with `visudo` before it is activated).
#
# Security model: the runner builds from the public repo that only you can push
# to; the sudo grant is limited to /bin/bash <workspace>/tools/deploy.sh, and
# deploy.sh runs `npm install --ignore-scripts` so dependencies can't execute
# code as root. The plugin's own code runs inside Homebridge as 'homebridge'.
set -euo pipefail

RUNNER_USER="ghrunner"
RUNNER_HOME="/home/${RUNNER_USER}/actions-runner"
REPO="homebridge-enbrighten-tuya"
WS="${RUNNER_HOME}/_work/${REPO}/${REPO}"

[ -x "${RUNNER_HOME}/run.sh" ] || { echo "ERROR: runner not configured at ${RUNNER_HOME}"; exit 1; }

echo "[1/2] Installing systemd unit github-runner.service ..."
cat > /etc/systemd/system/github-runner.service <<UNIT
[Unit]
Description=GitHub Actions Runner (andypohl/${REPO})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUNNER_USER}
WorkingDirectory=${RUNNER_HOME}
ExecStart=${RUNNER_HOME}/run.sh
Environment=HOME=/home/${RUNNER_USER}
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now github-runner.service
echo "      runner service: $(systemctl is-active github-runner) / $(systemctl is-enabled github-runner)"

echo "[2/2] Installing scoped sudoers rule (visudo-validated) ..."
TMP="$(mktemp)"
printf 'ghrunner ALL=(root) NOPASSWD: /bin/bash %s/tools/deploy.sh *\n' "$WS" > "$TMP"
visudo -cf "$TMP"
install -m 0440 -o root -g root "$TMP" /etc/sudoers.d/90-ghrunner-deploy
rm -f "$TMP"
echo "      installed /etc/sudoers.d/90-ghrunner-deploy:"
sed 's/^/        /' /etc/sudoers.d/90-ghrunner-deploy
echo "DONE"
