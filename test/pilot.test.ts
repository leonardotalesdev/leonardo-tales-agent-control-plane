import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { REGISTERED_ACTION_PROFILES } from '@leonardo-tales/policy-engine'
import { createCatalog, fixtureCatalog } from '../src/catalog.ts'
import { effectFiles, makeTask, openFixture } from '../src/demo.ts'
import { openHost, type OperatorReview, type PilotResult } from '../src/host.ts'

const runChild = promisify(execFile)
const approve = async () => 'APPROVED' as const
const deny = async () => 'DENIED' as const
const aRows = { rowIds: [1, 2, 3, 4] }
const bRows = { rowIds: [5, 6, 7] }

async function setup(t: TestContext, options: {
  review?: (request: OperatorReview) => Promise<'APPROVED' | 'DENIED' | 'PENDING'>
  action?: string
  unknown?: boolean
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'core-pilot-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const task = makeTask('test-task', new Date(Date.now() + 3_600_000).toISOString(), options.action)
  const reviews: OperatorReview[] = []
  const host = await openFixture(directory, task, async request => {
    reviews.push(request)
    return options.review ? options.review(request) : approve()
  }, options.unknown)
  let closed = false
  async function close() {
    if (!closed) {
      closed = true
      await host.close()
    }
  }
  // Cleanup after explicit assertions; close also before reopening in another process.
  return { directory, task, reviews, host, a: host.clients.get('agent-a')!, b: host.clients.get('agent-b')!, close }
}

type Client = NonNullable<ReturnType<Awaited<ReturnType<typeof openHost>>['clients']['get']>>

async function issue(client: Client, runId: string, input: unknown) {
  const proposal = await client.createOperation(runId, input)
  assert.ok('operationHandle' in proposal, JSON.stringify(proposal))
  return proposal.operationHandle
}

async function submitNew(client: Client, runId: string, input: unknown) {
  return client.submit(await issue(client, runId, input))
}

function receipt(result: PilotResult | null) {
  assert.ok(result && 'inputDigest' in result, 'expected a projected Gateway receipt')
  return result
}

async function readRecord(directory: string, name: string) {
  return JSON.parse(await readFile(join(directory, name), 'utf8'))
}

test('one approved action charges four rows and leaves one independently observed effect', async t => {
  const f = await setup(t)
  try {
    const handle = await issue(f.a, 'run-a', aRows)
    const r = receipt(await f.a.submit(handle))
    assert.equal(r.decision, 'EXECUTED')
    assert.deepEqual([r.requested, r.settled, r.held, r.remaining], [4, 4, 0, 6])
    assert.equal(f.reviews.length, 1)
    const [review] = f.reviews
    assert.equal(review.approverId, 'human-reviewer')
    assert.equal(review.requestId, r.approvalRequestId)
    assert.equal(review.amount, 4)
    assert.equal(review.operationKey, handle)
    assert.deepEqual(await effectFiles(f.directory), [r.evidenceId + '.json'])
    const effect = await readRecord(f.directory, r.evidenceId + '.json')
    assert.deepEqual(effect.effect, aRows)
    assert.deepEqual(effect.attribution, r.attribution)
  } finally { await f.close() }
})

test('two agents and Runs spend from the same Task allowance', async t => {
  const f = await setup(t)
  try {
    assert.equal((await submitNew(f.a, 'run-a', aRows)).decision, 'EXECUTED')
    const result = receipt(await submitNew(f.b, 'run-b', bRows))
    assert.equal(result.decision, 'EXECUTED')
    assert.deepEqual([result.settled, result.held, result.remaining], [7, 0, 3])
    assert.equal((await effectFiles(f.directory)).length, 2)
  } finally { await f.close() }
})

test('an approved four-row request exceeding the three remaining rows records its refusal basis', async t => {
  const f = await setup(t)
  try {
    await submitNew(f.a, 'run-a', aRows)
    await submitNew(f.b, 'run-b', bRows)
    const result = receipt(await submitNew(f.a, 'run-a', { rowIds: [8, 9, 10, 11] }))
    assert.equal(result.decision, 'BLOCKED')
    assert.equal(result.reason, 'task_limit')
    assert.equal(result.refusalBasis?.remaining, 3)
    assert.equal(result.refusalBasis?.requested, 4)
    assert.equal(result.remaining, 3)
    assert.equal((await effectFiles(f.directory)).length, 2)
  } finally { await f.close() }
})

test('host classification blocks the surrogate through Policy Engine before operator review', async t => {
  const f = await setup(t)
  try {
    const handle = await issue(f.a, 'run-a', { rowIds: [30] })
    const result = await f.a.submit(handle)
    assert.equal(result.decision, 'BLOCKED')
    assert.equal(result.reason, 'policy-block')
    assert.ok('violations' in result && result.violations?.length)
    assert.equal(f.reviews.length, 0)
    assert.deepEqual(await effectFiles(f.directory), [])
    const policy = await readRecord(f.directory, 'policy-' + handle + '.json')
    assert.equal(policy.decision, 'block')
    assert.equal(policy.facts.involvesRealUserData, true)
    assert.equal(policy.facts.humanApprovalPresent, false)
  } finally { await f.close() }
})

test('operator denial causes zero effects and survives reopening', async t => {
  const f = await setup(t, { review: deny })
  let first
  let handle
  try {
    handle = await issue(f.a, 'run-a', { rowIds: [1] })
    first = receipt(await f.a.submit(handle))
    assert.equal(first.decision, 'BLOCKED')
    assert.equal(first.reason, 'approval-denied')
    assert.equal(first.settled, 0)
    assert.equal(first.remaining, 10)
    assert.deepEqual(await effectFiles(f.directory), [])
  } finally { await f.close() }
  let reviews = 0
  const reopened = await openFixture(f.directory, f.task, async () => { reviews++; return 'APPROVED' })
  try {
    const replay = receipt(await reopened.clients.get('agent-a')!.submit(handle, { rowIds: [1] }))
    assert.equal(replay.decision, 'BLOCKED')
    assert.equal(replay.reason, first.reason)
    assert.equal(replay.approvalRequestId, first.approvalRequestId)
    assert.equal(reviews, 0)
    assert.deepEqual(await effectFiles(f.directory), [])
  } finally { await reopened.close() }
})

test('fresh operating-system process returns the original evidence and creates no second effect', async t => {
  const f = await setup(t)
  let original
  let before
  let handle
  try {
    await submitNew(f.a, 'run-a', aRows)
    handle = await issue(f.b, 'run-b', bRows)
    original = receipt(await f.b.submit(handle))
    before = await effectFiles(f.directory)
  } finally { await f.close() }
  const program = `
    import { openFixture } from './src/demo.ts'
    import { writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const [directory, json, handle] = process.argv.slice(1)
    let reviewCalls = 0
    const host = await openFixture(directory, JSON.parse(json), async () => { reviewCalls++; return 'PENDING' })
    try {
      const client = host.clients.get('agent-b')
      const inspected = await client.inspect(handle)
      const replay = await client.submit(handle, { rowIds: [5, 6, 7] })
      await writeFile(join(directory, 'child-result.json'), JSON.stringify({ inspected, replay, reviewCalls, pid: process.pid }),
        { mode: 0o600, flag: 'wx' })
    } finally { await host.close() }
  `
  await runChild(process.execPath, ['--input-type=module', '--eval', program, f.directory, JSON.stringify(f.task), handle],
    { cwd: new URL('../', import.meta.url), timeout: 15_000 })
  const { inspected, replay, reviewCalls, pid } = await readRecord(f.directory, 'child-result.json')
  assert.notEqual(pid, process.pid)
  assert.equal(reviewCalls, 0)
  assert.equal(replay.decision, 'EXECUTED')
  assert.equal(replay.replayed, true)
  assert.equal(replay.evidenceId, original.evidenceId)
  assert.equal(inspected.evidenceId, original.evidenceId)
  assert.deepEqual(replay.attribution, original.attribution)
  assert.equal(replay.remaining, 3)
  assert.deepEqual(await effectFiles(f.directory), before)
})

test('changed valid input under an existing operation key conflicts without review or dispatch', async t => {
  const f = await setup(t)
  try {
    const handle = await issue(f.a, 'run-a', aRows)
    const original = receipt(await f.a.submit(handle))
    const result = await f.a.submit(handle, { rowIds: [1, 2, 3] })
    assert.equal(result.decision, 'CONFLICT')
    assert.equal(f.reviews.length, 1)
    assert.equal(receipt(await f.a.inspect(handle)).inputDigest, original.inputDigest)
    assert.deepEqual(await effectFiles(f.directory), [original.evidenceId + '.json'])
  } finally { await f.close() }
})

test('cross-agent Run, replay and receipt inspection are all refused', async t => {
  const f = await setup(t)
  try {
    const handle = await issue(f.a, 'run-a', aRows)
    const r = receipt(await f.a.submit(handle))
    const forbidden = { decision: 'BLOCKED', reason: 'forbidden' }
    assert.deepEqual(await f.b.inspect(handle), forbidden)
    assert.deepEqual(await f.b.createOperation('run-a', aRows), forbidden)
    assert.deepEqual(await f.b.submit(handle, aRows), forbidden)
    assert.deepEqual(await f.a.createOperation('run-b', aRows), forbidden)
    assert.deepEqual(await effectFiles(f.directory), [r.evidenceId + '.json'])
    assert.equal(f.reviews.length, 1)
  } finally { await f.close() }
})

test('owner, proposing agent, approving operator, executor and evidence remain distinguishable', async t => {
  const f = await setup(t)
  try {
    const handle = await issue(f.b, 'run-b', bRows)
    const result = receipt(await f.b.submit(handle))
    const attribution = result.attribution
    assert.equal(attribution.ownerId, 'task-owner')
    assert.equal(attribution.agentId, 'agent-b')
    assert.equal(attribution.executorId, 'core-host')
    assert.equal(attribution.actionRevision, 1)
    assert.equal(attribution.actionId, 'fixture.rows')
    assert.equal(attribution.taskId, f.task.id)
    assert.equal(attribution.purpose, f.task.purpose)
    assert.equal(attribution.runId, 'run-b')
    assert.equal(attribution.operationKey, handle)
    assert.match(attribution.policyDigest, /^[a-f0-9]{64}$/)
    assert.match(attribution.intentDigest, /^[a-f0-9]{64}$/)
    const approval = await readRecord(f.directory, 'approval-' + handle + '.json')
    assert.equal(approval.approverId, 'human-reviewer')
    assert.equal(approval.requestDigest, f.reviews[0].requestDigest)
    assert.equal(approval.requestId, result.approvalRequestId)
    assert.deepEqual(f.reviews[0].attribution, attribution)
    const effect = await readRecord(f.directory, result.evidenceId + '.json')
    assert.deepEqual(effect.attribution, attribution)
    assert.equal(effect.evidenceId, result.evidenceId)
    assert.deepEqual(effect.effect, bRows)
  } finally { await f.close() }
})

test('recorded unknown retains capacity and never repeats the synthetic effect', async t => {
  const f = await setup(t, { unknown: true })
  const input = { rowIds: [1, 2, 3, 4, 5, 6] }
  try {
    const handle = await issue(f.a, 'run-a', input)
    const unknown = receipt(await f.a.submit(handle))
    assert.equal(unknown.decision, 'UNKNOWN')
    assert.deepEqual([unknown.settled, unknown.held, unknown.remaining], [0, 6, 4])
    const effects = await effectFiles(f.directory)
    assert.equal(effects.length, 1)
    const replay = receipt(await f.a.submit(handle, input))
    assert.equal(replay.decision, 'UNKNOWN')
    assert.equal(replay.held, 6)
    assert.deepEqual(await effectFiles(f.directory), effects)
    assert.equal(f.reviews.length, 1)
  } finally { await f.close() }
})

test('a second registered action has its own schema, synthetic handler and Task', async t => {
  const f = await setup(t, { action: 'fixture.labels' })
  try {
    const bad = await f.a.createOperation('run-a', bRows)
    assert.ok('reason' in bad)
    assert.equal(bad.reason, 'invalid-input')
    assert.equal(f.reviews.length, 0)
    const result = receipt(await submitNew(f.a, 'run-a', { labelIds: [7, 8] }))
    assert.equal(result.action, 'fixture.labels')
    assert.equal(result.decision, 'EXECUTED')
    assert.equal(result.remaining, 8)
    assert.deepEqual((await readRecord(f.directory, result.evidenceId + '.json')).effect, { labelIds: [7, 8] })
  } finally { await f.close() }
})

test('duplicate registration and unknown action revision fail closed before a task opens', async t => {
  const rows = fixtureCatalog.get('fixture.rows@1')!
  assert.throws(() => createCatalog([rows, rows]), /duplicate action registration/)
  const directory = await mkdtemp(join(tmpdir(), 'core-pilot-registry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const task = makeTask('test-task', new Date(Date.now() + 3_600_000).toISOString())
  await assert.rejects(openHost({
    directory, task: { ...task, actionRevision: 2 }, agents: [{ id: 'a', runs: ['one'] }],
    approverId: 'human', review: approve,
  }), /unknown-action-registration/)
  assert.deepEqual(await readdir(directory), [])
})

test('untrusted input cannot inject an agent identity or human approval claim', async t => {
  const f = await setup(t)
  try {
    for (const key of ['agentId', 'ownerId', 'approverId', 'humanApprovalPresent', 'policy']) {
      const result = await f.a.createOperation('run-a', { rowIds: [1], [key]: true })
      assert.ok('reason' in result)
      assert.equal(result.reason, 'invalid-input')
    }
    assert.equal(f.reviews.length, 0)
    assert.deepEqual(await effectFiles(f.directory), [])
  } finally { await f.close() }
})

test('host-issued handles identify distinct proposals without reviewing or spending at issuance', async t => {
  const f = await setup(t)
  try {
    const first = await issue(f.a, 'run-a', aRows)
    const second = await issue(f.a, 'run-a', aRows)
    assert.notEqual(first, second)
    assert.equal(f.reviews.length, 0)
    assert.deepEqual(await effectFiles(f.directory), [])
    assert.deepEqual(await f.b.inspect(first), { decision: 'BLOCKED', reason: 'forbidden' })

    const result = receipt(await f.a.submit(first, aRows))
    assert.equal(result.operationKey, first)
    assert.equal(result.attribution.operationKey, first)
    assert.equal(result.remaining, 6)
    assert.equal((await effectFiles(f.directory)).length, 1)
  } finally { await f.close() }
})

test('Task pause blocks both agents, survives reopening, and resumes the original pending request', async t => {
  const f = await setup(t, { review: async () => 'PENDING' })
  const paused = { decision: 'BLOCKED', reason: 'task-paused' }
  let handle: string
  let requestId: string | null
  try {
    handle = await issue(f.a, 'run-a', aRows)
    const pending = receipt(await f.a.submit(handle))
    assert.equal(pending.decision, 'APPROVAL_REQUIRED')
    requestId = pending.approvalRequestId
    assert.ok(requestId)
    await f.host.pause()
    assert.deepEqual(await f.a.submit(handle), paused)
    assert.deepEqual(await f.b.createOperation('run-b', bRows), paused)
    assert.equal(receipt(await f.a.inspect(handle)).approvalRequestId, requestId)
    assert.equal(f.reviews.length, 1)
    assert.deepEqual(await effectFiles(f.directory), [])
  } finally { await f.close() }

  const reviewed: OperatorReview[] = []
  const reopened = await openFixture(f.directory, f.task, async request => {
    reviewed.push(request)
    return 'APPROVED'
  })
  try {
    const a = reopened.clients.get('agent-a')!
    const b = reopened.clients.get('agent-b')!
    assert.deepEqual(await a.submit(handle, aRows), paused)
    assert.deepEqual(await b.createOperation('run-b', bRows), paused)
    assert.deepEqual(await b.submit(handle), { decision: 'BLOCKED', reason: 'forbidden' })
    assert.equal(receipt(await a.inspect(handle)).decision, 'APPROVAL_REQUIRED')
    assert.equal(reviewed.length, 0)
    await reopened.resume()
    const result = receipt(await a.submit(handle, aRows))
    assert.equal(result.decision, 'EXECUTED')
    assert.equal(result.approvalRequestId, requestId)
    assert.equal(reviewed[0].requestDigest, f.reviews[0].requestDigest)
    assert.equal(reviewed[0].expiresAt, f.reviews[0].expiresAt)
    assert.deepEqual([result.settled, result.held, result.remaining], [4, 0, 6])
    assert.deepEqual(await effectFiles(f.directory), [result.evidenceId + '.json'])
  } finally { await reopened.close() }
})

for (const resumeBeforeDecision of [false, true]) {
  const description = resumeBeforeDecision
    ? 'a review response made stale by a pause stays stale after resume'
    : 'pausing while the operator reviews prevents dispatch despite an approval response'
  test(description, { timeout: 10_000 }, async t => {
    let signalReviewStarted!: () => void
    let releaseReview!: () => void
    const reviewStarted = new Promise<void>(resolve => { signalReviewStarted = resolve })
    const reviewReleased = new Promise<void>(resolve => { releaseReview = resolve })
    const f = await setup(t, { review: async () => {
      signalReviewStarted()
      await reviewReleased
      return 'APPROVED'
    } })
    const handle = await issue(f.a, 'run-a', aRows)
    const attempt = f.a.submit(handle)
    try {
      await reviewStarted
      await f.host.pause()
      if (resumeBeforeDecision) await f.host.resume()
      releaseReview()
      const result = receipt(await attempt)
      assert.equal(result.decision, 'APPROVAL_REQUIRED')
      assert.deepEqual(await effectFiles(f.directory), [])
      const pending = receipt(await f.a.inspect(handle))
      assert.equal(pending.decision, 'APPROVAL_REQUIRED')
      assert.deepEqual([pending.settled, pending.held, pending.remaining], [0, 0, 10])
      assert.ok(!(await readdir(f.directory)).includes('approval-' + handle + '.json'))
      if (resumeBeforeDecision) {
        const resumed = receipt(await f.a.submit(handle))
        assert.equal(resumed.decision, 'EXECUTED')
        assert.equal(resumed.approvalRequestId, result.approvalRequestId)
        assert.equal(f.reviews.length, 2)
        assert.equal(f.reviews[1].requestDigest, f.reviews[0].requestDigest)
        assert.equal((await effectFiles(f.directory)).length, 1)
      }
    } finally {
      releaseReview()
      await attempt.catch(() => {})
      await f.close()
    }
  })
}

test('pausing after an uncertain dispatch preserves one effect and its hold across reopen', async t => {
  const f = await setup(t, { unknown: true })
  let handle: string
  let before: string[]
  try {
    handle = await issue(f.a, 'run-a', aRows)
    assert.equal(receipt(await f.a.submit(handle)).decision, 'UNKNOWN')
    before = await effectFiles(f.directory)
    assert.equal(before.length, 1)
    await f.host.pause()
    const inspected = receipt(await f.a.inspect(handle))
    assert.equal(inspected.decision, 'UNKNOWN')
    assert.deepEqual([inspected.settled, inspected.held, inspected.remaining], [0, 4, 6])
    assert.deepEqual(await effectFiles(f.directory), before)
  } finally { await f.close() }

  const reopened = await openFixture(f.directory, f.task, async () => assert.fail('uncertain replay cannot request approval'), true)
  try {
    const a = reopened.clients.get('agent-a')!
    const inspected = receipt(await a.inspect(handle))
    assert.deepEqual([inspected.settled, inspected.held, inspected.remaining], [0, 4, 6])
    await reopened.resume()
    const replay = receipt(await a.submit(handle))
    assert.equal(replay.decision, 'UNKNOWN')
    assert.deepEqual([replay.settled, replay.held, replay.remaining], [0, 4, 6])
    assert.deepEqual(await effectFiles(f.directory), before)
  } finally { await reopened.close() }
})

test('operator review contains the declared target and the request being decided', async t => {
  const f = await setup(t, { action: 'fixture.labels' })
  try {
    const result = receipt(await submitNew(f.b, 'run-b', { labelIds: [7, 8] }))
    const [review] = f.reviews
    assert.equal(review.target, 'synthetic-labels')
    assert.equal(review.attribution.agentId, 'agent-b')
    assert.equal(review.attribution.actionRevision, 1)
    assert.equal(review.action, 'fixture.labels')
    assert.deepEqual(review.input.items, [7, 8])
    assert.equal(review.amount, 2)
    assert.equal(review.unit, 'labels')
    assert.equal(review.requestId, result.approvalRequestId)
    assert.match(review.requestDigest, /^[a-f0-9]{64}$/)
    assert.ok(Number.isFinite(Date.parse(review.expiresAt)))
  } finally { await f.close() }
})

test('Task reopens with reordered equivalent configuration and refuses material changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'core-pilot-equivalent-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const task = makeTask('equivalent-task', new Date(Date.now() + 3_600_000).toISOString())
  const options = {
    directory, task, approverId: 'human',
    agents: [{ id: 'agent-a', runs: ['run-a', 'run-a2'] }, { id: 'agent-b', runs: ['run-b'] }],
    review: approve,
  }
  const host = await openHost(options)
  let handle: string
  let executed
  try {
    handle = await issue(host.clients.get('agent-a')!, 'run-a2', aRows)
    executed = receipt(await host.clients.get('agent-a')!.submit(handle))
  } finally { await host.close() }

  const equivalent = {
    actionRevision: task.actionRevision, actionId: task.actionId, expiresAt: task.expiresAt,
    cap: task.cap, ownerId: task.ownerId, purpose: task.purpose, id: task.id,
  }
  const reopened = await openHost({
    ...options, task: equivalent,
    agents: [{ id: 'agent-b', runs: ['run-b'] }, { id: 'agent-a', runs: ['run-a2', 'run-a'] }],
  })
  try {
    const result = receipt(await reopened.clients.get('agent-a')!.inspect(handle))
    assert.equal(result.evidenceId, executed.evidenceId)
    assert.deepEqual(result.attribution, executed.attribution)
    assert.equal(result.remaining, 6)
  } finally { await reopened.close() }

  await assert.rejects(openHost({ ...options, task: { ...task, cap: 11 } }), /conflict/)
  await assert.rejects(openHost({
    ...options, agents: [{ id: 'agent-a', runs: ['run-a'] }, { id: 'agent-b', runs: ['run-b', 'run-a2'] }],
  }), /conflict/)
  assert.equal((await effectFiles(directory)).length, 1)
})

test('authorized inspection recovers a persisted host policy refusal without a Gateway receipt', async t => {
  const f = await setup(t)
  let blocked: PilotResult
  let handle: string
  try {
    handle = await issue(f.a, 'run-a', { rowIds: [30] })
    blocked = await f.a.submit(handle)
    assert.equal(blocked.reason, 'policy-block')
    assert.ok('source' in blocked)
    assert.equal(blocked.source, 'host-policy')
    assert.equal(blocked.attribution.agentId, 'agent-a')
    assert.deepEqual(await f.a.inspect(handle), blocked)
    assert.deepEqual(await f.b.inspect(handle), { decision: 'BLOCKED', reason: 'forbidden' })
    assert.equal(f.reviews.length, 0)
    for (const field of ['inputDigest', 'approvalRequestId', 'evidenceId', 'settled', 'held', 'remaining']) {
      assert.equal(field in blocked, false)
    }
  } finally { await f.close() }

  const reopened = await openFixture(f.directory, f.task, async () => assert.fail('policy refusal cannot request approval'))
  try {
    const a = reopened.clients.get('agent-a')!
    assert.deepEqual(await a.inspect(handle), blocked)
    assert.deepEqual(await effectFiles(f.directory), [])
  } finally { await reopened.close() }
})

test('subsequent inspections, resume and replay record the bound requester without changing original attribution', async t => {
  let decision: 'PENDING' | 'APPROVED' = 'PENDING'
  const f = await setup(t, { review: async () => decision })
  try {
    const handle = await issue(f.a, 'run-a', aRows)
    const operationFile = join(f.directory, 'op-' + handle + '.json')
    const original = await readFile(operationFile)
    const pending = receipt(await f.a.submit(handle))
    assert.equal(pending.decision, 'APPROVAL_REQUIRED')
    assert.equal(receipt(await f.a.inspect(handle)).decision, 'APPROVAL_REQUIRED')
    assert.deepEqual(await f.b.inspect(handle), { decision: 'BLOCKED', reason: 'forbidden' })
    assert.deepEqual(await f.b.submit(handle, aRows), { decision: 'BLOCKED', reason: 'forbidden' })

    decision = 'APPROVED'
    const resumed = receipt(await f.a.submit(handle, aRows))
    assert.equal(resumed.decision, 'EXECUTED')
    const replay = receipt(await f.a.submit(handle, aRows))
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.attribution, resumed.attribution)
    assert.deepEqual(await readFile(operationFile), original)
    assert.deepEqual(await effectFiles(f.directory), [resumed.evidenceId + '.json'])

    const accessFiles = (await readdir(f.directory)).filter(name => name.startsWith('access-'))
    const accesses = await Promise.all(accessFiles.map(name => readRecord(f.directory, name)))
    assert.deepEqual(accesses.map(access => access.kind).sort(), ['inspect', 'replay', 'resume'])
    for (const access of accesses) {
      assert.equal(access.operationHandle, handle)
      assert.equal(access.requesterId, 'agent-a')
      assert.equal(access.runId, 'run-a')
      assert.equal(access.taskId, f.task.id)
      assert.ok(Number.isFinite(Date.parse(access.requestedAt)))
    }
  } finally { await f.close() }
})

test('changing a pending registration revision or declared policy cannot reuse its approval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'core-pilot-revision-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const task = makeTask('revision-task', new Date(Date.now() + 3_600_000).toISOString())
  const rows = fixtureCatalog.get('fixture.rows@1')!
  let calls = 0
  const revisionTwo = { ...rows, revision: 2, perform(items: readonly number[]) {
    calls++
    return rows.perform(items)
  } }
  const options = {
    directory, task, approverId: 'human', agents: [{ id: 'agent-a', runs: ['run-a'] }],
    catalog: createCatalog([rows, revisionTwo]), review: async () => 'PENDING' as const,
  }
  const first = await openHost(options)
  try {
    const a = first.clients.get('agent-a')!
    assert.equal(receipt(await submitNew(a, 'run-a', aRows)).decision, 'APPROVAL_REQUIRED')
  } finally { await first.close() }
  await assert.rejects(openHost({ ...options, task: { ...task, actionRevision: 2 } }), /conflict/)
  await assert.rejects(openHost({
    ...options, catalog: createCatalog([{ ...rows, policy: { ...rows.policy, target: 'other-local-target' } }]),
  }), /conflict/)
  assert.equal(calls, 0)
  assert.deepEqual(await effectFiles(directory), [])
})

test('Task pause and resume do not extend a pending approval expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await setup(t, { review: async () => 'PENDING' })
  try {
    const handle = await issue(f.a, 'run-a', aRows)
    const pending = receipt(await f.a.submit(handle))
    assert.equal(pending.decision, 'APPROVAL_REQUIRED')

    await f.host.pause()
    t.mock.timers.tick(Date.parse(f.reviews[0].expiresAt) - Date.now() + 1)
    await f.host.resume()

    const expired = receipt(await f.a.submit(handle))
    assert.equal(expired.decision, 'BLOCKED')
    assert.equal(expired.reason, 'expired')
    assert.equal(expired.approvalRequestId, pending.approvalRequestId)
    assert.equal(f.reviews.length, 1)
    assert.deepEqual(await effectFiles(f.directory), [])
  } finally { await f.close() }
})

test('a Task pause at the running handler leaves its dispatched effect intact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'core-pilot-dispatched-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const task = makeTask('dispatched-task', new Date(Date.now() + 3_600_000).toISOString())
  const rows = fixtureCatalog.get('fixture.rows@1')!
  let pauseTask!: () => Promise<void>
  let pauseWrite: Promise<void> | undefined
  const catalog = createCatalog([{
    ...rows,
    perform(items) {
      pauseWrite = pauseTask()
      return rows.perform(items)
    },
  }])
  const host = await openHost({
    directory, task, catalog, approverId: 'human',
    agents: [{ id: 'agent-a', runs: ['run-a'] }], review: approve,
  })
  pauseTask = () => host.pause()
  const a = host.clients.get('agent-a')!
  try {
    const result = receipt(await submitNew(a, 'run-a', aRows))
    assert.ok(pauseWrite)
    await pauseWrite
    assert.equal(result.decision, 'EXECUTED')
    assert.deepEqual([result.settled, result.held, result.remaining], [4, 0, 6])
    assert.deepEqual(await effectFiles(directory), [result.evidenceId + '.json'])
    assert.deepEqual(await a.createOperation('run-a', bRows), { decision: 'BLOCKED', reason: 'task-paused' })
  } finally { await host.close() }
})


test('local fixture registration rejects named Policy Engine profiles and extra rule declarations', () => {
  const rows = fixtureCatalog.get('fixture.rows@1')!
  for (const id of REGISTERED_ACTION_PROFILES) {
    assert.throws(() => createCatalog([{ ...rows, id }]), /named policy profiles/)
  }
  const unsupported = { ...rows, policy: { ...rows.policy, customRules: [] } }
  assert.throws(() => createCatalog([unsupported]), /invalid fixture policy/)
})
