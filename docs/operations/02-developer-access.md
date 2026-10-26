# Developer access: WireGuard, dxFeed broker and SSH

[Handbook](../README.md) · [Onboarding](00-developer-onboarding.md) ·
[Platform architecture](01-hosted-platform.md) ·
[Server runbook](03-server-runbook.md)

There are three independent kinds of access. Ask only for the ones your work
needs; repository access grants none of them.

| Access | Gives you | Does not give you |
|---|---|---|
| **WireGuard + gateway bearer** (layer 1) | Historical Mode and its studies; warm-up from the host's recorded history | Shell access, S3 credentials, service secrets, or live ticks from the host |
| **Tailscale broker access** (layer 2) | live dxFeed sessions opened by your own runtime | anything on the host, or the archive |
| **SSH account + personal key** | permitted inspection or administration of the Linux host | WireGuard or Tailscale access, unrestricted sudo, provider credentials |

## WireGuard and your gateway bearer

WireGuard makes the gateway reachable; the bearer proves the request is yours.
Both are needed, and both are yours alone: the owner issues a separate peer and
a separate bearer to each developer, so every developer has their own read
budget and can be revoked without affecting anyone else.

### What you send

Create an empty tunnel in the official WireGuard client (Windows, macOS) or with
the distribution's tools (Linux, with restrictive permissions on the key file).
Send the owner:

- your name; and
- the tunnel's **public** key.

Nothing else. Never send the private key; the owner does not need it and will
never ask for it.

### What you receive

In chat, your tunnel settings. They look like this, with real values:

```ini
[Interface]
# keep the PrivateKey line your WireGuard app generated
Address = 10.88.0.N/32

[Peer]
PublicKey = SERVER_PUBLIC_KEY
Endpoint = HOST_ADDRESS:51820
AllowedIPs = 10.88.0.1/32
PersistentKeepalive = 25
```

Paste them into your tunnel below its existing `PrivateKey` line and activate
it. `AllowedIPs` routes only the gateway through the tunnel; do not widen it.

Through a one-time secret link, your gateway **bearer**: a single random string,
shown to the owner once. Put it in both bearer lines of the repository-root
`.env`:

```text
TT_ARCHIVE_PROXY_URL=http://10.88.0.1:8001
VITE_ARCHIVE_CLIENT_TOKEN=<your-bearer>
TT_LIVE_STORAGE_SERVICE_URL=http://10.88.0.1:8001/live-storage
TT_LIVE_STORAGE_CLIENT_TOKEN=<your-bearer>
```

The same bearer appears twice because Vite reads the first pair and the runtime
the second. Restart both terminals after changing them, then run
`npm run doctor`.

Never put the bearer or a private key in source control, a ticket, a document
or a screenshot. If one leaks, tell the owner; they revoke it and issue a new
one in a minute.

### When doctor reports a failure

`npm run doctor` checks layer 1 in order and stops at the first step that
fails, naming it:

| Doctor says | Meaning | What to do |
|---|---|---|
| `configuration` | a variable is missing, still the `<your-bearer>` placeholder, or the two bearer lines differ | fix `.env` and rerun |
| `WireGuard` | `10.88.0.1:8001` cannot be reached | activate the tunnel; check `AllowedIPs` includes `10.88.0.1/32`; a failed ping proves nothing, because ICMP may be blocked |
| `gateway` | the gateway answered but is not ready | tell the owner; nothing on your side is wrong |
| `bearer` | the gateway refused your bearer (401/403) | check you pasted the whole bearer into both lines; if it is right, ask the owner whether it was revoked |
| `archive` | the archive refused or returned nothing for a day that is published | tell the owner |
| `live-storage` | the live-storage route did not answer properly | tell the owner |

A successful request that returns no rows can be valid: the host has no coverage
for that instrument and window. Historical Mode then says so on the chart.

The runtime itself does not report these failures loudly: when the host cannot
be reached, warm-up quietly reports the history as unavailable and indicators
start from live ticks. That is why `doctor` exists; run it whenever warm-up or
Historical Mode looks wrong.

### When access ends

The owner revokes the peer and the bearer together. Delete the tunnel and the
bearer lines from `.env`.

### Owner side

Issuing, rotating and revoking access is one command on the host, described in
the [server runbook](03-server-runbook.md#8-issue-rotate-and-revoke-developer-access).
The owner never needs a developer's private key, never shares the gateway's
token list, and never gives a developer `TT_QUERY_SERVICE_SECRET`,
`TT_LIVE_STORAGE_SERVICE_SECRET` or any S3 credential.

## Tailscale broker access (layer 2)

The dxFeed token broker is reachable only on the owner's tailnet. The owner
grants access in the Tailscale admin console. Once your laptop is on the
tailnet, set `TT_DXFEED_TOKEN_BROKER_URL` in `.env` to the broker's `https://`
address and restart Terminal C. `npm run doctor` checks only that the value is
well formed; it never contacts the broker, because every contact opens a
licensed session. Your runtime asks the broker for a short-lived token each
time you select a dxFeed instrument. Tokens are never written to `.env` or logs.


## SSH operator access

SSH opens a command shell on the Ubuntu host. It does not open a Windows
desktop, and closing a shell does not stop a systemd-managed service.

Ask the infrastructure owner privately for the host address, SSH port, Linux
username, approved permissions, and trusted server fingerprint. Each developer
uses a personal key; never share the bootstrap administrator key.

### Create a personal key

Run on the laptop. If the filename exists, choose another rather than
overwriting it. Use a passphrase.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\terminal_host_ed25519" -C "your-name-terminal-host"
Get-Content "$env:USERPROFILE\.ssh\terminal_host_ed25519.pub"
```

Give the owner only `terminal_host_ed25519.pub`. The extension may appear as a
Windows Publisher file association; it is still a text public key. The private
file never leaves the laptop.

### Save and verify the connection

Add this to `%USERPROFILE%\.ssh\config` on Windows or `~/.ssh/config` on
Linux/macOS, replacing owner-supplied placeholders:

```sshconfig
Host terminal-host
    HostName HOST_ADDRESS
    Port SSH_PORT
    User YOUR_LINUX_USERNAME
    IdentityFile ~/.ssh/terminal_host_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking ask
    HostKeyAlgorithms ssh-ed25519
    ConnectTimeout 15
```

Connect with `ssh terminal-host`. On first connection, compare the displayed
fingerprint with the value obtained through a trusted independent channel.
Accept only a match, then set `StrictHostKeyChecking yes`.

Inside the verified shell, run:

```bash
whoami
hostname
date -u
```

Start with the server runbook's read-only health checks. Operator actions and
sudo require separately granted permission. Do not edit a deployed immutable
release in place.

### SSH troubleshooting

| Symptom | Next action |
|---|---|
| Connection timeout | Confirm host, port, current source-network allowance, and whether a VPN route is required. |
| `Permission denied (publickey)` | Check username, key path, agent selection, and whether the owner installed that public key. |
| Host key changed | Stop and verify with the owner; do not delete the saved identity merely to suppress the warning. |
| `sudo` denied | Request the minimum required operator role; do not borrow another person's credentials. |
| PowerShell works but WSL fails | They use different home directories, keys, agents, and SSH configuration. |

VS Code Remote SSH can use the same shortcut but may require forwarding that
host policy disables. Review that requirement rather than weakening policy for
editor convenience. Provider recovery-console access is a separate account
capability. Type `exit` to close the SSH session.
