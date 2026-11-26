import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  createActionGateway, type ActionInput, type ActionReceipt, type ActionReview,
} from '@leonardo-tales/action-gateway'
import { evaluatePolicy, type PolicyEvaluationInput } from '@leonardo-tales/policy-engine'
import { canonicalDigest, fixtureCatalog } from './catalog.ts'
import { openStore } from './store.ts'

type Task = {
  id: string
  purpose: string
  ownerId: string
  cap: number
  expiresAt: string
  actionId: string
  actionRevision: number
}

type Agent = { id: string; runs: readonly string[] }
type Decision = 'APPROVED' | 'DENIED' | 'PENDING'

export type Attribution = Readonly<{
  taskId: string
  purpose: string
  ownerId: string
  agentId: string
  runId: string
  operationKey: string
  executorId: string
  actionId: string
  actionRevision: number
  policyDigest: string
  intentDigest: string
}>

export type OperatorReview = Readonly<ActionReview & { attribution: Attribution; approverId: string; target: string }>
type HostRefusal =
  | { decision: 'BLOCKED'; reason: 'forbidden' | 'invalid-input' | 'task-paused' }
  | { decision: 'CONFLICT'; reason: 'operation-conflict' }
type PolicyRefusal = Readonly<{
  decision: 'BLOCKED'
  reason: 'policy-block'
  source: 'host-policy'
  violations: readonly string[]
  attribution: Attribution
}>
export type PilotResult = HostRefusal | PolicyRefusal | (ActionReceipt & { attribution: Attribution })
export type Client = Readonly<{
  createOperation(runId: string, input: unknown): Promise<{ operationHandle: string } | HostRefusal>
  submit(operationHandle: string, input?: unknown): Promise<PilotResult>
  inspect(operationHandle: string): Promise<PilotResult | null>
}>

type HostOptions = {
  directory: string
  task: Task
  agents: readonly Agent[]
  approverId: string
  review(request: OperatorReview): Promise<Decision>
  unknownAfterEffect?: boolean
  catalog?: typeof fixtureCatalog
}

type Operation = { attribution: Attribution; items: number[] }
type TaskManifest = {
  task: Task
  agents: readonly Agent[]
  approverId: string
  executorId: string
  policyDigest: string
  unknownAfterEffect: boolean
}
type PolicyObservation = {
  facts: PolicyEvaluationInput
  decision: ReturnType<typeof evaluatePolicy>['decision']
  violationIds: string[]
}
type Approval = {
  approverId: string
  requestId: string
  requestDigest: string
  expiresAt: string
  decidedAt: string
  decision: Exclude<Decision, 'PENDING'>
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value)
}

function canonicalInput(operation: Operation): ActionInput {
  const { operationKey, actionId, actionRevision, policyDigest } = operation.attribution
  return {
    items: operation.items,
    binding: { operationKey, actionId, actionRevision, policyDigest, attributionDigest: canonicalDigest(operation.attribution) },
  }
}

function manifestDigest(manifest: TaskManifest): string {
  const agents = manifest.agents.map(agent => ({ ...agent, runs: [...agent.runs].sort() }))
  agents.sort((left, right) => left.id < right.id ? -1 : Number(left.id > right.id))
  return canonicalDigest({ ...manifest, agents })
}

function policyRefusal(policy: PolicyObservation | null, operation: Operation): PolicyRefusal | null {
  if (policy?.decision !== 'block') return null
  return {
    decision: 'BLOCKED', reason: 'policy-block', source: 'host-policy',
    violations: policy.violationIds, attribution: operation.attribution,
  }
}

const forbidden = () => ({ decision: 'BLOCKED', reason: 'forbidden' } as const)
const pausedRefusal = () => ({ decision: 'BLOCKED', reason: 'task-paused' } as const)

export async function openHost(options: HostOptions) {
  const { directory, approverId, review, unknownAfterEffect = false, catalog = fixtureCatalog } = options
  const task = Object.freeze({ ...options.task })
  const agents = options.agents.map(({ id, runs }) => ({ id, runs: [...runs] }))
  const runIds = agents.flatMap(agent => agent.runs)
  const registered = catalog.get(`${task.actionId}@${task.actionRevision}`)
  if (!registered) throw new Error('unknown-action-registration')
  const action = registered
  if (!safeId(task.id) || !safeId(task.ownerId) || !safeId(approverId)
    || typeof task.purpose !== 'string' || task.purpose.length < 1 || task.purpose.length > 256
    || !Number.isSafeInteger(task.cap) || task.cap < 1
    || !Number.isFinite(Date.parse(task.expiresAt)) || new Date(task.expiresAt).toISOString() !== task.expiresAt
    || !agents.length || agents.length > 8 || runIds.length > 16
    || agents.some(agent => !safeId(agent.id) || agent.runs.length === 0)
    || new Set(agents.map(agent => agent.id)).size !== agents.length
    || runIds.some(run => !safeId(run)) || new Set(runIds).size !== runIds.length) {
    throw new Error('invalid-host-config')
  }
  const policyDigest = canonicalDigest({
    evaluator: '@leonardo-tales/policy-engine@0.3.0',
    hostPolicyVersion: 1,
    action: { id: action.id, revision: action.revision, unit: action.unit },
    policy: action.policy,
  })
  const store = await openStore(directory)
  const executorId = 'core-host'
  let busy = false
  let closed = false
  let observers = 0
  let paused = false
  let pauseEpoch = 0
  let operationEpoch = 0
  let controlTail = Promise.resolve()
  let controlRequests = 0
  let controlRevision = 0

  async function exclusive<T>(request: () => Promise<T>): Promise<T> {
    if (busy || closed) throw new Error(closed ? 'host-closed' : 'host-busy')
    busy = true
    try {
      return await request()
    } finally {
      busy = false
    }
  }

  async function observe<T>(request: () => Promise<T>): Promise<T> {
    if (closed) throw new Error('host-closed')
    observers++
    try {
      return await request()
    } finally {
      observers--
    }
  }

  function setPaused(next: boolean): Promise<void> {
    if (closed) return Promise.reject(new Error('host-closed'))
    if (next) {
      paused = true
      pauseEpoch++
    }
    controlRequests++
    const revision = ++controlRevision
    const update = controlTail.then(async () => {
      await store.replace('admission.json', { paused: next })
      if (revision === controlRevision) paused = next
    })
    controlTail = update.catch(() => {
      paused = true
      pauseEpoch++
    })
    return update.finally(() => { controlRequests-- })
  }

  function admissionStopped(epoch: number): boolean {
    return paused || epoch !== pauseEpoch
  }

  function evaluate(items: readonly number[], approved: boolean): PolicyObservation {
    const facts: PolicyEvaluationInput = {
      subjectType: 'tool-action',
      title: action.id,
      description: action.policy.description,
      requestedAction: action.policy.target,
      permissionTier: action.policy.permissionTier,
      riskHints: [...action.policy.riskHints],
      involvesSecrets: false,
      involvesProduction: false,
      involvesExternalIntegration: false,
      involvesRealUserData: items.some(item => action.policy.blockedItems.includes(item)),
      involvesFinancialOrLegalOrHealthData: false,
      proposesCommitOrPush: false,
      proposesDeployment: false,
      proposesPublicClaim: false,
      humanApprovalPresent: approved,
    }
    const result = evaluatePolicy(facts)
    return { facts, decision: result.decision, violationIds: result.violations.map(violation => violation.id) }
  }

  async function loadOperation(key: string): Promise<Operation | null> {
    const record = await store.read<Operation>(`op-${key}.json`)
    if (!record) return null
    const { attribution, items } = record
    if (attribution.operationKey !== key || attribution.taskId !== task.id || attribution.purpose !== task.purpose
      || attribution.ownerId !== task.ownerId || attribution.executorId !== executorId
      || attribution.actionId !== action.id || attribution.actionRevision !== action.revision
      || attribution.policyDigest !== policyDigest
      || !agents.some(agent => agent.id === attribution.agentId && agent.runs.includes(attribution.runId))
      || attribution.intentDigest !== canonicalDigest(items)) {
      throw new Error('invalid-operation-attribution')
    }
    return record
  }

  async function verifyBoundInput(input: ActionInput, key: string): Promise<Operation> {
    if (!safeId(key)) throw new Error('invalid-operation-key')
    const record = await loadOperation(key)
    if (!record || canonicalDigest(canonicalInput(record)) !== canonicalDigest(input)) {
      throw new Error('operation-binding-mismatch')
    }
    return record
  }

  function project(receipt: ActionReceipt, operation: Operation): PilotResult {
    const { attribution } = operation
    // The released Gateway documents compact JSON with UTF-16 key ordering.
    if (receipt.inputDigest !== canonicalDigest(canonicalInput(operation))
      || receipt.runId !== attribution.runId || receipt.operationKey !== attribution.operationKey
      || receipt.taskId !== attribution.taskId || receipt.action !== attribution.actionId) {
      throw new Error('receipt-binding-mismatch')
    }
    return { ...receipt, attribution }
  }

  try {
    const manifest = { task, agents, approverId, executorId, policyDigest, unknownAfterEffect }
    const previous = await store.read<TaskManifest>('task.json')
    if (previous === null) await store.create('task.json', manifest)
    else if (manifestDigest(previous) !== manifestDigest(manifest)) throw new Error('store-record-conflict')
    const admission = await store.read<{ paused: boolean }>('admission.json')
    if (admission !== null && typeof admission.paused !== 'boolean') throw new Error('invalid-admission-state')
    paused = admission?.paused ?? false
    const gatewayDirectory = join(directory, 'gateway')
    await mkdir(gatewayDirectory, { mode: 0o700, recursive: true })
    const gateway = await createActionGateway({
      directory: gatewayDirectory,
      task: { id: task.id, cap: task.cap, unit: action.unit, expiresAt: task.expiresAt },
      approverId,
      tool: {
        id: action.id,
        revision: action.revision,
        amount(input) {
          if (!Array.isArray(input.items)) throw new Error('invalid-canonical-input')
          return input.items.length
        },
        async execute(input, signal) {
          const epoch = operationEpoch
          const binding = input.binding as { operationKey: string }
          const operation = await verifyBoundInput(input, binding.operationKey)
          // Gateway may have reserved already. Preserve its hold if pause wins before the effect.
          // This final check and the synchronous fixture handler start cannot interleave.
          if (signal.aborted || admissionStopped(epoch)) return { outcome: 'unknown' }
          const effect = action.perform(operation.items)
          // A fresh record per invocation exposes duplicate effects in the fixtures.
          const evidenceId = `effect-${binding.operationKey}-${randomUUID()}`
          await store.create(`${evidenceId}.json`, { evidenceId, attribution: operation.attribution, effect })
          return unknownAfterEffect ? { outcome: 'unknown' } : { outcome: 'executed', evidenceId }
        },
      },
      async review(request) {
        const epoch = operationEpoch
        if (admissionStopped(epoch)) return 'PENDING'
        const record = await verifyBoundInput(request.input, request.operationKey)
        if (request.taskId !== task.id || request.runId !== record.attribution.runId
          || request.action !== action.id || request.amount !== record.items.length || request.unit !== action.unit
          || request.cap !== task.cap || Date.now() >= Date.parse(request.expiresAt) || admissionStopped(epoch)) return 'PENDING'

        const path = `approval-${request.operationKey}.json`
        let approval = await store.read<Approval>(path)
        if (admissionStopped(epoch)) return 'PENDING'
        if (!approval) {
          const decision = await review({ ...request, attribution: record.attribution, approverId, target: action.policy.target })
          if (admissionStopped(epoch) || (decision !== 'APPROVED' && decision !== 'DENIED')) return 'PENDING'
          const decidedAt = new Date().toISOString()
          if (decidedAt >= request.expiresAt) return 'PENDING'
          approval = {
            approverId, requestId: request.requestId, requestDigest: request.requestDigest,
            expiresAt: request.expiresAt, decidedAt, decision,
          }
          await store.create(path, approval)
        }
        if (approval.approverId !== approverId || approval.requestId !== request.requestId
          || approval.requestDigest !== request.requestDigest || approval.expiresAt !== request.expiresAt
          || approval.decidedAt >= request.expiresAt || Date.now() >= Date.parse(request.expiresAt)) return 'PENDING'
        const policy = evaluate(record.items, approval.decision === 'APPROVED')
        await store.ensure(`review-policy-${request.operationKey}.json`, policy)
        if (admissionStopped(epoch)) return 'PENDING'
        if (approval.decision === 'APPROVED' && policy.decision !== 'allow') return 'DENIED'
        return approval.decision
      },
    })

    function readPolicy(operationHandle: string) {
      return store.read<PolicyObservation>(`policy-${operationHandle}.json`)
    }

    async function recordAccess(kind: 'inspect' | 'resume' | 'replay', record: Operation, requesterId: string) {
      const { operationKey, runId, taskId } = record.attribution
      await store.create(`access-${randomUUID()}.json`, {
        kind, operationHandle: operationKey, requesterId, runId, taskId,
        requestedAt: new Date().toISOString(),
      })
    }

    const clients = new Map<string, Client>()
    for (const agent of agents) {
      clients.set(agent.id, Object.freeze({
        createOperation: async (runId, input) => {
          if (closed) throw new Error('host-closed')
          if (!agent.runs.includes(runId)) return forbidden()
          if (paused) return pausedRefusal()
          return exclusive(async () => {
            let items: number[]
            try {
              items = action.normalize(input)
            } catch {
              return { decision: 'BLOCKED', reason: 'invalid-input' } as const
            }
            const operationHandle = `op-${randomUUID()}`
            const record: Operation = {
              items,
              attribution: {
                taskId: task.id, purpose: task.purpose, ownerId: task.ownerId,
                agentId: agent.id, runId, operationKey: operationHandle, executorId, actionId: action.id,
                actionRevision: action.revision, policyDigest, intentDigest: canonicalDigest(items),
              },
            }
            await store.create(`op-${operationHandle}.json`, record)
            return { operationHandle }
          })
        },
        submit: (operationHandle, input) => observe(async (): Promise<PilotResult> => {
          const epoch = pauseEpoch
          const wasPaused = paused
          if (!safeId(operationHandle)) return forbidden()
          const record = await loadOperation(operationHandle)
          if (!record || record.attribution.agentId !== agent.id) return forbidden()
          const subsequentRequest = async () => {
            const policy = await readPolicy(operationHandle)
            if (policy === null) return
            const receipt = await gateway.inspect(operationHandle)
            const terminal = policy.decision === 'block' || (receipt !== null && receipt.decision !== 'APPROVAL_REQUIRED')
            await recordAccess(terminal ? 'replay' : 'resume', record, agent.id)
          }
          if (wasPaused || admissionStopped(epoch)) {
            await subsequentRequest()
            return pausedRefusal()
          }
          return exclusive(async () => {
            operationEpoch = epoch
            await subsequentRequest()
            if (admissionStopped(epoch)) return pausedRefusal()
            if (input !== undefined) {
              let items: number[]
              try {
                items = action.normalize(input)
              } catch {
                return { decision: 'BLOCKED', reason: 'invalid-input' }
              }
              if (record.attribution.intentDigest !== canonicalDigest(items)) {
                return { decision: 'CONFLICT', reason: 'operation-conflict' }
              }
            }
            const policy = evaluate(record.items, false)
            await store.ensure(`policy-${operationHandle}.json`, policy)
            const refusal = policyRefusal(policy, record)
            if (refusal) return refusal
            if (admissionStopped(epoch)) return pausedRefusal()
            return project(await gateway.execute({
              runId: record.attribution.runId, operationKey: operationHandle, input: canonicalInput(record),
            }), record)
          })
        }),
        inspect: (operationHandle) => observe(async (): Promise<PilotResult | null> => {
          if (!safeId(operationHandle)) return forbidden()
          const record = await loadOperation(operationHandle)
          if (!record || record.attribution.agentId !== agent.id) return forbidden()
          await recordAccess('inspect', record, agent.id)
          const refusal = policyRefusal(await readPolicy(operationHandle), record)
          if (refusal) return refusal
          const receipt = await gateway.inspect(operationHandle)
          return receipt && project(receipt, record)
        }),
      }))
    }

    return {
      clients: clients as ReadonlyMap<string, Client>,
      pause: () => setPaused(true),
      resume: () => setPaused(false),
      async close() {
        if (busy || observers || controlRequests || closed) throw new Error(closed ? 'host-closed' : 'host-busy')
        closed = true
        await store.close()
      },
    }
  } catch (error) {
    await store.close()
    throw error
  }
}
