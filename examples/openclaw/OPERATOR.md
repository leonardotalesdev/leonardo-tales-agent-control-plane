# Run the supervised synthetic example

Run these commands from the example root in three local Bash terminals as the account that bootstrapped the reference. Use a fresh Task and a fresh OpenClaw session. The fixed session key `agent:main:i4-b2` is part of the reviewed plugin contract. Keep the checkout and its runtime data private and use a parent directory controlled by trusted users. The Gateway, plugin, stdio child, and operator share one OS account.

## Disable the fresh profile's heartbeat before account setup

Bootstrap sets both tool allowlists to empty and disables cron and triggers. On a fresh OpenClaw profile the Proactive check can still be registered as enabled. With the profile still free of model credentials, start the foreground Gateway.

```bash
./bin/openclaw-lab gateway run --port 18791 --bind loopback --auth token --tailscale off
```

In a second terminal, disable heartbeat and verify the ready profile. If health still reports the old heartbeat state, wait for the status to refresh and repeat the health check. Stop on a persistent mismatch. Stop the Gateway with **Ctrl+C** in the first terminal before connecting an account.

```bash
./bin/openclaw-lab system heartbeat disable
./bin/openclaw-lab gateway health --json |
  jq -e '.ok and .coreReady and (.agents | length > 0 and all(.[]; .heartbeat.enabled == false)) and
    .channels == {} and .sessions.count == 0'
./bin/openclaw-lab gateway call cron.status --json |
  jq -e '.enabled == false and .nextWakeAtMs == null'
```

## Connect your own model account

With the Gateway stopped and both tool allowlists empty, complete Codex OAuth in your browser for an account entitled to use GPT-6.1 Sol Standard. Any redirect URL or authorization code belongs only in the local login process. Confirm the account and workspace, available included quota, a zero credit balance, and that automatic credit reload and paid overage are disabled or unavailable. Stop if eligibility or billing is uncertain. [Pinned OpenClaw authentication guide](https://github.com/openclaw/openclaw/blob/v2026.11.10/docs/providers/openai/authentication.md)

```bash
./bin/openclaw-lab models auth login --provider openai --method oauth --agent main \
  --profile-id openai:reference-codex
./bin/openclaw-lab models auth order set --provider openai --agent main openai:reference-codex
./bin/openclaw-lab models list --agent main --provider openai --refresh --json
```

Require a ready catalog response for that OAuth profile and an available `openai/gpt-6.1-sol` entry. An unsuccessful refresh can leave an older catalog visible. Use status `--check` for metadata in the procedure below. Status `--probe` and interactive model tests can submit inference. [Pinned models CLI](https://github.com/openclaw/openclaw/blob/v2026.11.10/docs/cli/models.md)

## Terminal 1 · Preflight and start the Gateway

The bootstrap initializes the private Task. If your installation leaves Task initialization to the operator, create it once with `./runtime/node/bin/node integration/mcp/operator.mjs init "$PWD/profile/i2-mcp"`. A previously used or expired Task needs a fresh, separately bootstrapped workspace. The direct MCP test uses its own Task.

```bash
umask 077
run_dir=$(mktemp -d "$PWD/profile/manual.XXXXXX") || exit
retry_settings=profile/state/agents/main/agent/settings.json
printf 'Private run directory for Terminal 3\n%s\n' "$run_dir"
(
  set -euo pipefail
  listeners=$(ss -H -ltn 'sport = :18791')
  test -z "$listeners"
  [[ ! -e "$retry_settings" && ! -L "$retry_settings" ]]
  ./bin/openclaw-lab --version | grep -Fx 'OpenClaw 2026.11.10 (6ea542f)'
  ./bin/openclaw-lab config validate --json | jq -e '.valid == true'
  jq -e '.tools.alsoAllow == [] and .tools.gatewayPolicy.allow == [] and
    ([.mcp.servers[].enabled] == [false]) and
    .gateway.bind == "loopback" and .gateway.auth.mode == "token"' profile/openclaw.json
  ./runtime/node/bin/node integration/mcp/operator.mjs list "$PWD/profile/i2-mcp/adapter.json" |
    jq -e '. == []'
  jq -e '.task | .cap == 10 and .actionId == "fixture.rows" and .actionRevision == 1 and
    (.expiresAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) > now' profile/i2-mcp/state/task.json
  effect_file=$(find profile/i2-mcp/state -maxdepth 1 -type f -name 'effect-*.json' -print -quit)
  test -z "$effect_file"
  ./bin/openclaw-lab models status --agent main --json --check |
    jq -e '.defaultModel == "openai/gpt-6.1-sol" and .resolvedDefault == .defaultModel and
      .fallbacks == [] and .auth.missingProvidersInUse == [] and .auth.modelRouteIssues == [] and
      [.auth.providers[] | {provider, count: .profiles.count, oauth: .profiles.oauth,
        token: .profiles.token, apiKey: .profiles.apiKey, env, modelsJson}] ==
      [{provider:"openai",count:1,oauth:1,token:0,apiKey:0,env:null,modelsJson:null}]'
  ./bin/openclaw-lab models auth order get --provider openai --agent main --json |
    jq -e '.order == ["openai:reference-codex"]'
  ./bin/openclaw-lab status --usage --agent main --json --timeout 10000 |
    jq -e '[.usage.providers[] | select(.provider == "openai")] |
      length == 1 and (.[0] | .error == null and
        (.windows | length > 0 and all(.[]; (.usedPercent | type) == "number" and
          .usedPercent >= 0 and .usedPercent < 100 and .resetAt > (now * 1000))) and
        any(.billing[]; .type == "balance" and .unit == "credits" and .amount == 0))'
  cp -p profile/openclaw.json "$run_dir/openclaw.before.json"
)
```

Proceed only after the full preflight passes. Prepare Terminals 2 and 3 before you submit a prompt. If activation or startup fails, follow the cleanup section.

```bash
(
  set -euo pipefail
  cmp -- profile/openclaw.json "$run_dir/openclaw.before.json"
  (set -o noclobber; printf '%s\n' '{"retry":{"provider":{"maxRetries":0}}}' > "$retry_settings")
  printf '%s\n' '{"logging":{"audit":{"executionIdentity":true}},"tools":{"alsoAllow":["leonardo__synthetic_rows"],"gatewayPolicy":{"allow":["leonardo__synthetic_rows"]}}}' |
    ./bin/openclaw-lab config patch --stdin
  ./bin/openclaw-lab config validate --json | jq -e '.valid == true'
  jq -e '.tools.alsoAllow == ["leonardo__synthetic_rows"] and
    .tools.gatewayPolicy.allow == .tools.alsoAllow and
    ([.mcp.servers[].enabled] == [false]) and
    .plugins.allow == ["openai","leonardo-tool-consent"] and
    .plugins.entries["leonardo-tool-consent"].enabled and .plugins.entries.codex.enabled == false and
    .agents.defaults.models["openai/gpt-6.1-sol"].agentRuntime.id == "openclaw" and
    .agents.defaults.models["openai/gpt-6.1-sol"].params.fastMode == false and
    .gateway.bind == "loopback" and .gateway.auth.mode == "token" and
    .gateway.tailscale.mode == "off" and .gateway.controlUi.enabled == false and
    .gateway.terminal.enabled == false and .browser.enabled == false and
    .tools.exec.security == "deny" and .tools.elevated.enabled == false and
    .tools.codeMode.enabled == false and .tools.toolSearch == false and
    .tools.web.search.enabled == false and .tools.web.fetch.enabled == false and
    .hooks.enabled == false and .channels == {} and
    .cron.enabled == false and .cron.triggers.enabled == false' profile/openclaw.json
  ./bin/openclaw-lab gateway run --port 18791 --bind loopback --auth token --tailscale off
)
```

## Terminal 3 · Check readiness

```bash
umask 077
read -r -p 'Private run directory from Terminal 1: ' run_dir
node="$PWD/runtime/node/bin/node"
operator="$PWD/integration/mcp/operator.mjs"
task="$PWD/profile/i2-mcp/adapter.json"
state="$PWD/profile/i2-mcp/state"
(
  set -euo pipefail
  [[ "$run_dir" == "$PWD/profile/manual."* && -O "$run_dir" && -f "$run_dir/openclaw.before.json" ]]
  ss -H -ltn 'sport = :18791' |
    awk '$4=="127.0.0.1:18791" {ipv4=1}
         $4!="127.0.0.1:18791" && $4!="[::1]:18791" {other=1}
         END {exit !(ipv4 && !other)}'
  ./bin/openclaw-lab gateway health --json |
    jq -e '.ok and .coreReady and (.agents | length > 0 and
      all(.[]; .heartbeat.enabled == false)) and .channels == {} and .sessions.count == 0'
  ./bin/openclaw-lab gateway call cron.status --json |
    jq -e '.enabled == false and .nextWakeAtMs == null'
  ./bin/openclaw-lab plugins inspect leonardo-tool-consent --runtime --json |
    jq -e '.gatewayRuntime.state == "active" and .plugin.status == "loaded" and
      .mcpServers == [] and .tools == [{names:["leonardo__synthetic_rows"],optional:true}] and
      .typedHooks == [{name:"before_tool_call"}]'
)
```

## Terminal 2 · Propose once and consent

```bash
./bin/openclaw-lab tui --session agent:main:i4-b2
```

Confirm the TUI is connected to the local Gateway and shows agent `main`, session `i4-b2`, model `gpt-6.1-sol`, and `deliver:off`. Manually enter one prompt.

> For this synthetic test, call leonardo__synthetic_rows exactly once with `{"rowIds":[1,2]}`. Report the operation handle, approval request ID, decision, and accounting, then stop. Do not submit any other call.

The consent dialog has a 90-second window. Select **Allow once** only if the plugin is `leonardo-tool-consent`, the tool is `leonardo__synthetic_rows`, and the exact arguments are `{"rowIds":[1,2]}`. **Deny** is the default. On a mismatch, denial, expiry, or unexpected call, stop. Use `/abort` to cancel the current run.

## Terminal 3 · Authorize the exact ACP request

After the tool returns `APPROVAL_REQUIRED` with zero settled, zero held, and ten remaining, copy its exact request ID and original operation handle. Read the full request and confirm the effect count is zero. The five-minute ACP window begins when the request is created.

```bash
read -r -p 'Request ID: ' request_id
read -r -p 'Original operation handle: ' operation_handle
(
  set -euo pipefail
  "$node" "$operator" list "$task" |
    jq -e --arg id "$request_id" 'length == 1 and .[0].request.requestId == $id and
      .[0].decision == null and .[0].expired == false'
  "$node" "$operator" show "$task" "$request_id" | tee "$run_dir/exact-request.json"
  jq -e --arg id "$request_id" --arg handle "$operation_handle" --slurpfile manifest "$state/task.json" '
    .requestId == $id and .operationKey == $handle and ($handle | test("^op-[a-z0-9-]+$")) and
    .taskId == $manifest[0].task.id and .action == "fixture.rows" and
    .attribution.actionRevision == 1 and .input.items == [1,2] and .amount == 2 and
    .unit == "rows" and .cap == 10 and .target == "synthetic-rows" and
    .attribution.ownerId == $manifest[0].task.ownerId and
    .attribution.agentId == "openclaw-lab" and .attribution.runId == "openclaw-mcp-run" and
    .approverId == $manifest[0].approverId and .attribution.executorId == $manifest[0].executorId and
    .attribution.policyDigest == $manifest[0].policyDigest and (.requestDigest | test("^[a-f0-9]{64}$"))
  ' "$run_dir/exact-request.json"
  effect_file=$(find "$state" -maxdepth 1 -type f -name 'effect-*.json' -print -quit)
  test -z "$effect_file"
  jq -n '{checkedAt:(now | todate), effects:0}' > "$run_dir/effects-before-approval.json"
)
```

Only if the check passes and you approve the exact request, personally enter its full `requestDigest` from the displayed record. Use `deny` to record a refusal, then stop.

```bash
read -r -p 'Full request digest: ' request_digest
(
  set -euo pipefail
  "$node" "$operator" approve "$task" "$request_id" "$request_digest" |
    tee "$run_dir/operator-decision.json"
  "$node" "$operator" list "$task" |
    jq -e --arg id "$request_id" --arg digest "$request_digest" 'length == 1 and
      .[0].expired == false and .[0].request.requestId == $id and
      .[0].decision.requestId == $id and .[0].decision.requestDigest == $digest and
      .[0].decision.decision == "APPROVED"'
)
```

## Terminal 2 · Resume the original handle under fresh consent

Before the ACP request expires, substitute the actual handle and manually enter one prompt.

> Resume this synthetic export. Call leonardo__synthetic_rows exactly once with `{"operationHandle":"ORIGINAL_HANDLE"}`. Use only that argument. Report the receipt and accounting, then stop.

Select **Allow once** only for a fresh request from the same plugin displaying exactly the original handle as its only argument. Expect `EXECUTED / confirmed-success`, **2 settled, 0 held, 8 remaining**, and one effect for `[1,2]`. End the session after this result. The direct MCP harness covers replay.

## Terminal 3 · Inspect the original records

```bash
(
  set -euo pipefail
  ./bin/openclaw-lab audit --session agent:main:i4-b2 --json > "$run_dir/activity.json"
  ./bin/openclaw-lab gateway call approval.history --json --params '{"kind":"plugin","limit":50}' |
    jq '[.items[] | select(.source.sessionKey == "agent:main:i4-b2")]' > "$run_dir/consent.json"
  ./bin/openclaw-lab sessions export-trajectory --session-key agent:main:i4-b2 \
    --workspace "$PWD/workspace" --output "$(basename "$run_dir")" --json > "$run_dir/trajectory-location.json"
  find "$state" -maxdepth 1 -type f -name 'effect-*.json' -print > "$run_dir/effects.txt"
  find "$state/gateway/state" -type f -path '*/execution/*.json' -print > "$run_dir/executions.txt"
  find "$state/gateway/state" -type f -path '*/gateway-attempts/*.json' -print > "$run_dir/attempts.txt"
  test "$(wc -l < "$run_dir/effects.txt")" -eq 1
  test "$(wc -l < "$run_dir/executions.txt")" -eq 1
  test "$(wc -l < "$run_dir/attempts.txt")" -eq 1
  effect_file=$(cat "$run_dir/effects.txt")
  evidence_id=$(jq -er --arg handle "$operation_handle" '
    select(.effect.rowIds == [1,2] and .attribution.operationKey == $handle) | .evidenceId' "$effect_file")
  execution_id=$(jq -er '.record.payload | select(.status == "executed") | .id' "$(cat "$run_dir/executions.txt")")
  jq -e --arg execution "$execution_id" --arg evidence "$evidence_id" '
    .record.payload | .binding.executionId == $execution and .phase == "closed" and
    .result.status == "confirmed-success" and .result.evidenceRef.id == $evidence' "$(cat "$run_dir/attempts.txt")"
  jq -e --arg id "$request_id" --arg digest "$request_digest" '
    .decision == "APPROVED" and .requestId == $id and .requestDigest == $digest and .decidedAt < .expiresAt
  ' "$state/approval-$operation_handle.json"
)
```

Inspect the private trajectory's runtime tool results for the original handle, approval request ID, evidence ID, and final accounting. Compare the proposal and resume arguments to their two consent records. Keep the trajectory, prompts, logs, and Task state in the private workspace. Share only selected synthetic fields after review.

## Terminal 1 · Shut down and restore

Exit the TUI. Press **Ctrl+C** in the foreground Gateway terminal. After the process exits, restore the zero-tool profile from Terminal 1. Run the same cleanup after a failed or aborted run. If the shell closed, reopen it in the example root, set `run_dir` to the printed directory, and set `retry_settings=profile/state/agents/main/agent/settings.json` first.

```bash
(
  set -euo pipefail
  listeners=$(ss -H -ltn 'sport = :18791')
  test -z "$listeners"
  jq -e '.tools.alsoAllow == [] and .tools.gatewayPolicy.allow == [] and
    ([.mcp.servers[].enabled] == [false])' "$run_dir/openclaw.before.json"
  restored=$(mktemp profile/.openclaw-restore.XXXXXX)
  trap 'test ! -e "$restored" || rm -f -- "$restored"' EXIT
  cp -- "$run_dir/openclaw.before.json" "$restored"
  mv -T -- "$restored" profile/openclaw.json
  if [[ -e "$retry_settings" || -L "$retry_settings" ]]; then
    [[ -f "$retry_settings" && ! -L "$retry_settings" ]]
    printf '%s\n' '{"retry":{"provider":{"maxRetries":0}}}' | cmp - "$retry_settings"
    rm -- "$retry_settings"
  fi
  cmp -- profile/openclaw.json "$run_dir/openclaw.before.json"
  ./bin/openclaw-lab config validate --json | jq -e '.valid == true'
  jq -e '.tools.alsoAllow == [] and .tools.gatewayPolicy.allow == [] and
    ([.mcp.servers[].enabled] == [false])' profile/openclaw.json
)
```

Preserve the Task and private run artifacts. If the comparison fails, keep the Gateway stopped and compare the saved preflight profile with the current configuration before any later run.
