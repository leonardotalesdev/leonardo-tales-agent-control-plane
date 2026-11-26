# Architecture

Leonardo Tales Agent Control Plane v0.1.0 governs one registered synthetic action and one allowance unit per Task. A trusted foreground Linux process owns the Task directory and all access to its fixture handler. Independent agent clients may propose work against the same Task cap.

| Component | Responsibility |
| --- | --- |
| Agent Control Plane host | Fix Task purpose, expiry, scope, operator and allowed Runs. Issue operation handles, bind agent attribution, normalize inputs, derive policy facts, collect exact operator decisions and control the fixture handler. |
| Policy Engine 0.3.0 | Evaluate the supplied facts. The host evaluates the local policy before submitting to Gateway and again with the operator decision before approving a request. |
| Action Gateway 0.2.0 | Bind review to a specific request, enforce the shared allowance, dispatch the handler, and record receipts and replay state. Gateway alone calculates settled, held and remaining capacity. |
| Operator | Review the exact request and record approval, denial or pending review. Use the host’s separate Task pause and resume controls. |

## Task and request lifecycle

1. The trusted application opens a private Task directory with a purpose, owner, expiry, cap, operator, agent-to-Run assignments and one registered action revision. Reopening with equivalent settings preserves the same state. A material configuration change is refused. Order alone does not change the identity of Task fields, agents or Run assignments.
2. Give each agent only its own bound client. `client.createOperation(runId, input)` validates the Run and input and issues a durable `operationHandle`. The handle binds the originator, original Run and normalized items. Retain that handle.
3. `client.submit(operationHandle)` sends the proposed operation through policy evaluation and Gateway. The operator sees the target, canonical input, attribution, amount, request ID, digest and expiry. An exact approval is necessary for a first dispatch, and Gateway refuses requests that exceed the remaining capacity.
4. `client.inspect(operationHandle)` observes state for the original client. A persisted host policy refusal reports `source: 'host-policy'`, attribution and violations. Gateway receipts report allowance totals and any effect reference. An issued handle can have no outcome yet.
5. After an interrupted response, inspect the original handle or resubmit it under the original client. An exact terminal replay returns the recorded outcome. Changed valid input supplied with that handle returns `CONFLICT`. Authorized subsequent inspection, resume and replay requests record the requesting client separately from the original attribution.

## Registration and evidence

A trusted developer sets the action ID and revision, unit, target, allowed and restricted IDs, exact input normalizer, and local effect handler. This version normalizes a request to distinct positive safe integer IDs from the registered allowlist. The host classifies restricted synthetic surrogate IDs through the policy’s real-user-data fact. Other facts follow the fixed local tier-2, medium-risk template. The meter counts normalized IDs. The handler must limit the actual effect to those IDs and the registered target.

The policy digest covers the declared registration and the host policy and evaluator versions. The canonical Gateway input binds the action revision, policy digest, IDs and original attribution. Change the action revision when changing the handler or normalizer behavior. The developer owns that revision discipline.

The host preserves the owner, originating agent, Run, operation, executor and policy binding. Fixture effects have separate evidence records. Gateway receipts convey its observed outcome and Task allowance. The example uses synthetic identities under the local operator’s OS control.

## Pause, replay and uncertain outcomes

An acknowledged `await host.pause()` persists across reopening. It blocks new proposals and submissions, including pending resumptions. Inspection remains available. `await host.resume()` restores admission through the same controls and preserves the approval ID, original expiry and existing holds. A review interrupted by a pause must be submitted again.

The final pause cutoff is immediately before the synchronous fixture handler starts. An effect already underway continues. If pause wins after Gateway reserves capacity and before the handler starts, the host skips the handler and Gateway records `UNKNOWN` with the reservation held. Inspect the original handle and preserve the Task directory. A new handle would start a separate operation. Replaying an unknown outcome returns the recorded uncertainty without another dispatch.

The host has no automatic recovery or lock removal. Gateway reconciliation requires separate authorization and eligible durable history. Some crash histories retain capacity without qualifying for reconciliation. A timeout may precede a late effect. Writer locks, persistence uncertainties and damaged records can block execution or inspection. Preserve the Task directory when its state is uncertain.

## Trust boundary

The application is responsible for local identity, operator access, trustworthy policy facts, handler correctness, and exclusive custody of the Task directory and effect path. The supported environment is one foreground process on Linux with durable local storage and cooperating access. Remote or production authentication, distributed execution, network filesystems, arbitrary storage failure, provider-side exactly-once execution and signed evidence are outside the verified scope. OpenClaw and Hermes integrations and broad constitutional compliance certification are outside the verified scope.
