# Leonardo Tales Agent Control Plane

**Govern. Authorize. Execute. Audit.**

Leonardo Tales Agent Control Plane is a model-independent control layer for accountable AI agent actions, prepared for open-source release. Existing agent applications can use it to enforce policy boundaries, require exact human approval, share limits across a Task, and trace what executed.

Version 0.1.0 demonstrates these controls with synthetic actions and local identities in one trusted Linux process. Organization-wide agent management is a longer-term direction.

## Quickstart

Use Linux with Node.js 22.22.2 and npm 11.21.3 to reproduce the verified source workflow. The source commands use Node's native TypeScript type stripping. Use a private, owner-controlled Task directory on a local filesystem with durable rename and sync operations. The workflow needs no LLM account.

From the distributed source directory, run the locked installation and checks.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run demo
```

The scripted demo prints its private evidence directory and `report.json`. It exercises exact approval, pause, refusal under a ten-row cap, replay, and an uncertain outcome. [Verification summary](VERIFICATION.md) · [Dependency provenance](PROVENANCE.md)

## Developer examples

### Try exact approval as an operator

Run `npm run manual` in an interactive terminal. It creates a private temporary evidence directory. To choose the location, pass an absolute path after `--` under an existing parent. The path must be new or an empty canonical directory you own with mode `0700`.

1. Review Agent A’s four-row request. Check the target, originating agent, action revision, item IDs, amount, request ID and digest, and expiry. Enter the displayed `APPROVE` phrase.
2. Review and approve Agent B’s three-row request. The Task now has two effects and three rows remaining.
3. Enter `PAUSE`. Agent A’s attempted submission and Agent B’s new proposal both return `BLOCKED/task-paused`. Inspection of B’s prior receipt stays available. Enter `RESUME`.
4. Approve the next four-row request. Gateway returns `BLOCKED/task_limit` and records four rows requested with three remaining.
5. The program reopens the same Task directory, inspects and exactly replays B’s operation. Check that the evidence ID persists, the effect count stays two, and the operator receives no new approval prompt.

Use a fresh run to try `DENY` on the first request and observe zero effects. Enter `PENDING` then `STOP` to leave the request pending. Choose `REVIEW` to retry the same request within its original expiry.

### Register another synthetic action

Run `npm run example:registration` to register a tiles action with its own revision, target, allowed and restricted IDs, normalizer, and handler. The example rejects an off-list ID, blocks a restricted ID through Policy Engine, and records one approved tile effect. The contract supports a fixed host-derived fact template and a count of normalized, distinct fixture IDs. [Registration example](examples/register-synthetic.ts)

### Build and use the local package

Run `npm run build` in the installed source tree to emit ESM and TypeScript declarations. The archive uses the npm package name `@leonardo-tales/agent-control-plane`. The compiled package declares Node.js `>=22.18.0` on Linux and loads JavaScript without source TypeScript stripping. After installing the local archive, use the compiled exports.

```js
import { openHost } from '@leonardo-tales/agent-control-plane'
import { createCatalog } from '@leonardo-tales/agent-control-plane/catalog'
```

Use the source directory with its lockfile for development and the automated fixture workflows.

## Architecture

The host issues operation handles, binds agent attribution, validates input, derives policy facts, and manages operator review. Policy Engine evaluates the host’s facts. Action Gateway owns admission against the Task cap, handler dispatch, accounting, receipts, and replay state. Each Task has one registered action and one allowance unit. [Architecture guide](ARCHITECTURE.md)

## Security and trust boundaries

The supported environment is one foreground process on a trusted Linux host with synthetic actions, local identities, and private local storage. The host operator and developer are responsible for identity, facts, and handler correctness. Production authentication, distributed execution, enterprise fleet management, comprehensive security assurance, OpenClaw and Hermes integrations, and constitutional compliance certification are outside the verified scope. [Security policy and proposed private reporting](SECURITY.md)

## Governance

Leonardo Tales Constitution v1.1.1 governs the project’s internal decisions. Original product materials are licensed under Apache-2.0. The exact canonical Constitution is licensed separately under CC BY 4.0. Those licenses define downstream rights. Internal project governance adds no conditions to their exercise. [Constitution](LEONARDO_TALES_CONSTITUTION.md) · [License scope and attribution](NOTICE.md) · [Project boundary](PROJECT_BOUNDARY.md) · [Human approval gate](HUMAN_APPROVAL_GATE.md) · [Contributing](CONTRIBUTING.md)
