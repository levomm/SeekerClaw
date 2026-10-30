# SeekerClaw ACP delegation (pilot)

Owner-only Telegram commands send **asynchronous, read-oriented coding-agent
jobs** to a separate Linux ACP worker. This is an optional feature: no env vars
means no network call or changed behavior in the existing agent.

Prompts are passed to acpx through stdin, not shell-interpreted arguments.
The worker refuses to start as root.

It uses [acpx](https://acpx.sh/quickstart.html) to talk to the official
Agent Client Protocol adapters for Codex, Claude and Pi. The Android embedded
Node.js runtime is **not** asked to run acpx or install npm packages.

## Architecture

```
Telegram owner -> SeekerClaw /acp -> HTTPS -> Caddy -> 127.0.0.1:8787
                                                     |
                                                  ACP bridge (Node >=22.13)
                                                     |
                                        acpx --format json <agent> exec <prompt>
                                                     |
                                           allowlisted offline checkout
```

API: `GET /healthz`, `GET /v1/jobs`, `POST /v1/jobs`,
`GET /v1/jobs/{id}`, `POST /v1/jobs/{id}/cancel`.
**Every endpoint** requires `Authorization: Bearer <secret>`.
The worker runs one agent at a time, queues up to eight, has a 15-minute
execution deadline and keeps the last 100 job statuses **in memory**.
It does not persist jobs across worker restarts. The phone may disconnect after
submission; the worker continues while the server process remains running.

## Install on a test Ubuntu server

Requirements: Node >=22.13, `acpx` installed on PATH, one or more configured
ACP adapters, and a supported authentication method for each agent. Check
`node -v` first. Do not install this on the production e-commerce server.

```sh
sudo npm install -g acpx@latest
node -v
acpx --version

# Separate account. No write permission on checked-out repositories.
sudo useradd --system --create-home --home-dir /var/lib/acpworker --shell /usr/sbin/nologin acpworker
sudo install -d -m 755 /srv/acp/repos
sudo git clone --depth 1 https://github.com/levomm/SeekerClaw.git /srv/acp/repos/SeekerClaw
sudo chown -R root:root /srv/acp/repos/SeekerClaw
sudo chmod -R a-w /srv/acp/repos/SeekerClaw

# Have the SeekerClaw checkout (including this bridge) available to the service,
# e.g. through the cloned repository above.
sudo install -d -m 750 -o root -g acpworker /etc/seeker-acp
sudo cp /srv/acp/repos/SeekerClaw/tools/acp-bridge/config.example.json /etc/seeker-acp/config.json
printf 'ACP_BRIDGE_TOKEN=%s\nACP_BRIDGE_CONFIG=/etc/seeker-acp/config.json\n' "$(openssl rand -hex 32)" \
  | sudo tee /etc/seeker-acp/bridge.env >/dev/null
sudo chmod 600 /etc/seeker-acp/bridge.env
sudo chown root:acpworker /etc/seeker-acp/config.json
sudo chmod 640 /etc/seeker-acp/config.json
```

If you want to review a private repository, arrange a **redacted, read-only
working copy** under `/srv/acp/repos/` and explicitly map its name in
`config.json`. Never point this worker at production `.env` files, credential
stores, live database backups, or writeable deployment directories.

Authenticate ACP adapters separately as the `acpworker` account or pass only
the appropriate provider API keys through the protected systemd EnvironmentFile.
The `acpx` built-in Codex/Claude adapters may fetch npm packages on first use.
Audit the adapters and lock package versions before a production rollout.

Test it (without a bot) under the same account, after configuring auth:

```sh
sudo -u acpworker -H acpx --format quiet --approve-reads --no-terminal \
  --non-interactive-permissions deny --cwd /srv/acp/repos/SeekerClaw \
  codex exec 'Summarize this repository. Make no changes.'
```

Start the worker under systemd with a **real** Node 22+ absolute path (edit
`ExecStart` if `command -v node` is not `/usr/bin/node`):

```ini
[Unit]
Description=SeekerClaw ACP job worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=acpworker
Group=acpworker
WorkingDirectory=/srv/acp/repos/SeekerClaw
EnvironmentFile=/etc/seeker-acp/bridge.env
Environment=HOME=/var/lib/acpworker
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /srv/acp/repos/SeekerClaw/tools/acp-bridge/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/acpworker

[Install]
WantedBy=multi-user.target
```

Save as `/etc/systemd/system/seeker-acp.service`, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now seeker-acp.service
sudo systemctl status seeker-acp.service
```

`ACP_BRIDGE_HOST` is intentionally locked to `127.0.0.1`. Do **not** bind this
worker directly to a public interface. Place it behind a TLS reverse proxy,
for example Caddy (replace the domain with your own HTTPS hostname):

```caddy
acp.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Generate DNS + HTTPS first. Keep the bearer token secret, and add IP/rate limits
or another strong access layer at the proxy where practical. A VPN-only
network can also be used, but the SeekerClaw client requires HTTPS for a
remote hostname (HTTP is accepted only for `127.0.0.1`).

## Connect from SeekerClaw (Android)

Open **Settings -> Env Vars** and set these keys:

- `SEEKER_ACP_URL=https://acp.example.com` (HTTPS origin, no path)
- `SEEKER_ACP_TOKEN=<the exact value of ACP_BRIDGE_TOKEN>`

The existing Android config bridge loads these into the embedded Node.js
process. Restart the agent if they are not picked up immediately.

Telegram commands (owner-only through SeekerClaw's existing authorization):

```
/acp help
/acp codex seekerclaw Find potential regressions in the message handler. Do not change files.
/acp list
/acp status <returned-job-uuid>
/acp cancel <returned-job-uuid>
```

If the bridge is not configured, `/acp help` still works and all other `/acp`
commands report that the feature is disabled.

### Why analysis-only by default?

`--approve-reads --non-interactive-permissions deny --no-terminal` blocks
ordinary ACP write/terminal approvals, **but it is not an OS sandbox**.
Some adapters expose native shell/file operations outside ACP permissions.
The defense is the dedicated low-privilege account and **root-owned, read-only
checkout** with no live secrets. No autonomous branch pushes, deployments,
or purchases are implemented.

A second phase could add an isolated, disposable edit worktree, human approval,
CI tests and an explicit PR review. Do not simply flip to `--approve-all` in
this HTTP worker.

## Tests

```sh
node --test tools/acp-bridge/server.test.js tests/nodejs-project/acp-remote.test.js
node tests/nodejs-project/telegram-commands.test.js
```

The unit tests mock `acpx`; they validate request authentication, CLI argument
construction, status parsing, cancellation, and command routing. A **real
end-to-end ACP adapter run has not been tested** until the server-side manual
smoke test above succeeds with provider authentication.
