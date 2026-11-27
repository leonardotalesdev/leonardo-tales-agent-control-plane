# OpenClaw reference for Leonardo Tales Agent Control Plane

A supervised, single-user example that lets an OpenClaw model propose a local synthetic row export. The native consent plugin owns the single optional agent-facing tool, `leonardo__synthetic_rows`. It forwards exact, individually consented calls to the private stdio MCP adapter. ACP requires a separate exact operator approval. Action Gateway owns the shared ten-row allowance and controls dispatch to the synthetic fixture handler.

## Install

Use Linux x86-64 with glibc. Install Bash, curl, GNU coreutils, tar, xz, jq, OpenSSL, and iproute2. Run the example as a regular user. Use a fresh directory and parent directories controlled by trusted users. Keep a writable example checkout private, such as with mode `0700`. Run the following from the example directory.

```bash
chmod 700 .
./bin/bootstrap
```

Bootstrap downloads Node.js **24.22.3** and checks the Linux x64 archive SHA-256 against the reviewed value. It checks for bundled npm **11.19.1** and uses two npm lockfiles to install OpenClaw **2026.11.10**, Leonardo Tales ACP **0.1.0**, Policy Engine **0.3.0**, Action Gateway **0.2.0**, MCP SDK **1.32.2**, and Zod **4.6.7**. Both installs disable npm lifecycle scripts. The pinned OpenClaw launcher can complete its own shipped package initialization on first use. The bootstrap creates a fresh token-authenticated loopback profile on port 18791 and an owner-only synthetic Task with a ten-row cap and seven-day expiry. It leaves both tool allowlists empty and direct agent-facing MCP disabled.

The plugin resolves the adapter from its installed package root. Keep the relative layout of `integration/consent`, `integration/mcp`, `profile/i2-mcp`, and `runtime/node`. The consent harness imports build-specific OpenClaw internals from `runtime/npm/lib/node_modules/openclaw/dist`. Use the pinned versions and placement for this reference.

Bootstrap is for a fresh directory. If setup stops partway, use a fresh copy of the example. Preserve existing private Task and evidence files.

## Verify locally

Run the corrected consent harness with the OpenClaw Gateway stopped. It uses the embedded tool constructor and approval broker with an inert stdio fixture and simulated decisions. It checks disabled, absent, and withheld tools as well as denial, timeout, cancellation, invalid binding, and single-use forwarding. It requires local child-process and IPC support.

```bash
umask 077
env -i PATH="$PWD/runtime/node/bin:/usr/bin:/bin" HOME=/tmp LANG=C.UTF-8 \
  ./runtime/node/bin/node integration/consent/verify-correction.mjs
```

To exercise the direct MCP interface, initialize a **separate** verification Task. Stage checks discovery, input and identity binding, policy and scope refusals, and exact approval requests with zero effects. The direct client connects to stdio while agent-facing MCP remains disabled.

```bash
umask 077
node="$PWD/runtime/node/bin/node"
operator="$PWD/integration/mcp/operator.mjs"
verify_dir=$(mktemp -d "$PWD/profile/direct.XXXXXX")
task="$verify_dir/task"
"$node" "$operator" init-verification "$task"
"$node" integration/mcp/verify.mjs stage "$task/adapter.json" "$verify_dir/evidence"
"$node" "$operator" list "$task/adapter.json"
```

For a full direct verification, inspect the three pending requests. In a separate local terminal, use `operator.mjs show CONFIG REQUEST_ID` to read each full review. Enter `operator.mjs approve CONFIG REQUEST_ID FULL_REQUEST_DIGEST` with the same pinned Node executable only after deciding to authorize that exact request. Then run:

```bash
"$node" integration/mcp/verify.mjs resume "$task/adapter.json" "$verify_dir/evidence"
```

Resume checks two attributed effects, shared allowance accounting, over-cap refusal, and exact replay. Complete the review and resume within five minutes of request creation. End the test on denial or expiry. Start any later attempt with another fresh verification Task.

## Run the supervised model example

Use your own eligible Codex OAuth account and follow the [operator workflow](OPERATOR.md) for metadata preflight, temporary one-tool exposure, both consent controls, the exact original-handle resume, inspection, and shutdown. [Verification summary](VERIFICATION.md)

## Trust boundary

The Gateway, plugin, adapter, operator, and private evidence share the launching OS account. The clean process environment, owner-only files, loopback listener, and tool policy limit this lab configuration. Any process that can write the account's code, configuration, Task, or evidence can affect that trust boundary. Keep generated profile, workspaces, logs, exports, and runtime files private. Published examples and evidence should use synthetic input only.
