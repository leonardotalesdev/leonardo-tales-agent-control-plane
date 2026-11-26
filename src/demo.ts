import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { openHost, type Client, type PilotResult } from './host.ts'

type HostOptions = Parameters<typeof openHost>[0]
type Review = HostOptions['review']
type Task = HostOptions['task']
type Terminal = ReturnType<typeof createInterface>

const firstRows = { rowIds: [1, 2, 3, 4] }
const secondRows = { rowIds: [5, 6, 7] }
const excessRows = { rowIds: [8, 9, 10, 11] }

export function makeTask(id: string, expiresAt: string, actionId = 'fixture.rows'): Task {
  return {
    id, purpose: 'Review a bounded release of synthetic fixture items.',
    ownerId: 'task-owner', cap: 10, expiresAt, actionId, actionRevision: 1,
  }
}

export function openFixture(directory: string, task: Task, review: Review, unknownAfterEffect = false) {
  return openHost({
    directory, task, review, unknownAfterEffect, approverId: 'human-reviewer',
    agents: [{ id: 'agent-a', runs: ['run-a'] }, { id: 'agent-b', runs: ['run-b'] }],
  })
}

export async function effectFiles(directory: string) {
  return (await readdir(directory)).filter(name => name.startsWith('effect-') && name.endsWith('.json')).sort()
}

async function newPrivateDirectory(parent: string, name: string) {
  const directory = join(parent, name)
  await mkdir(directory, { mode: 0o700 })
  return directory
}

async function evidenceRoot(argument?: string) {
  if (!argument) return mkdtemp(join(tmpdir(), 'core-pilot-evidence-'))
  const path = resolve(argument)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const status = await lstat(path)
  if (!status.isDirectory() || (status.mode & 0o777) !== 0o700
    || status.uid !== process.getuid!() || await realpath(path) !== path || (await readdir(path)).length) {
    throw new Error('Choose a new directory or an empty canonical directory owned by you with mode 0700.')
  }
  return path
}

async function issue(client: Client, runId: string, input: unknown): Promise<string> {
  const issued = await client.createOperation(runId, input)
  if (!('operationHandle' in issued)) {
    throw new Error(`Could not issue a demo operation for ${runId} (${issued.reason}).`)
  }
  return issued.operationHandle
}

async function operatorCommand(terminal: Terminal | undefined, command: 'PAUSE' | 'RESUME') {
  if (!terminal) return
  const prompt = `Type ${command} to ${command.toLowerCase()} the Task: `
  while ((await terminal.question(prompt)).trim() !== command) {
    process.stdout.write(`The Task state changes when you enter ${command}.\n`)
  }
}

async function submitFixture(client: Client, handle: string, terminal?: Terminal) {
  let result = await client.submit(handle)
  while (terminal && result.decision === 'APPROVAL_REQUIRED') {
    const answer = await terminal.question('Type REVIEW to retry this pending request or STOP to leave it pending: ')
    if (answer.trim() !== 'REVIEW') return result
    result = await client.submit(handle)
  }
  return result
}

async function rowSequence(directory: string, task: Task, review: Review, terminal?: Terminal) {
  const report: Record<string, unknown> = { task }
  function record(name: string, label: string, result: PilotResult | null) {
    report[name] = result
    if (terminal && result) {
      const balance = 'remaining' in result ? `, ${result.remaining} ${result.unit} remaining` : ''
      process.stdout.write(`\n${label}: ${result.decision} (${result.reason})${balance}\n`)
    }
  }

  const host = await openFixture(directory, task, review)
  let secondHandle: string
  try {
    const first = host.clients.get('agent-a')!
    const second = host.clients.get('agent-b')!
    const firstHandle = await issue(first, 'run-a', firstRows)
    const firstResult = await submitFixture(first, firstHandle, terminal)
    record('first', 'Agent A requested four rows', firstResult)
    if (firstResult.decision !== 'EXECUTED') return { ...report, stoppedAfter: 'agent-a', effects: await effectFiles(directory) }

    secondHandle = await issue(second, 'run-b', secondRows)
    const secondResult = await submitFixture(second, secondHandle, terminal)
    record('second', 'Agent B requested three rows', secondResult)
    if (secondResult.decision !== 'EXECUTED') return { ...report, stoppedAfter: 'agent-b', effects: await effectFiles(directory) }

    const excessHandle = await issue(first, 'run-a', excessRows)
    await operatorCommand(terminal, 'PAUSE')
    await host.pause()
    record('paused', 'Attempted submission while paused', await first.submit(excessHandle))
    const freshWhilePaused = await second.createOperation('run-b', { rowIds: [12] })
    if ('operationHandle' in freshWhilePaused) throw new Error('The paused Task issued a new operation handle.')
    record('pausedFresh', 'Agent B attempted a new proposal while paused', freshWhilePaused)
    record('pausedInspection', 'Inspected the second operation while paused', await second.inspect(secondHandle))
    await operatorCommand(terminal, 'RESUME')
    await host.resume()
    record('limit', 'Agent A requested four additional rows', await submitFixture(first, excessHandle, terminal))

    const policyHandle = await issue(first, 'run-a', { rowIds: [30] })
    report.policy = await first.submit(policyHandle)
    report.policyInspection = await first.inspect(policyHandle)
    report.otherAgentLookup = await second.inspect(firstHandle)
    report.otherAgentReplay = await second.submit(firstHandle)
    report.effectsBeforeReopen = await effectFiles(directory)
  } finally { await host.close() }

  if (terminal) process.stdout.write('\nClosed the host. Reopening the same Task directory to inspect and replay Agent B’s original operation.\n')
  let reviewCallsAfterReopen = 0
  const reopened = await openFixture(directory, task, request => {
    reviewCallsAfterReopen++
    return review(request)
  })
  try {
    const second = reopened.clients.get('agent-b')!
    record('inspection', 'Inspected after reopening', await second.inspect(secondHandle))
    record('replay', 'Replayed the exact request after reopening', await second.submit(secondHandle, secondRows))
    report.conflict = await second.submit(secondHandle, { rowIds: [5, 6] })
    report.effectsAfterReopen = await effectFiles(directory)
  } finally { await reopened.close() }
  return { ...report, reviewCallsAfterReopen }
}

async function scripted(root: string, expiresAt: string) {
  const rows = await newPrivateDirectory(root, 'rows')
  const reviews: Array<{ operationKey: string; requestDigest: string; decision: 'APPROVED' | 'DENIED' }> = []
  function operator(decision: 'APPROVED' | 'DENIED'): Review {
    return async request => {
      reviews.push({ operationKey: request.operationKey, requestDigest: request.requestDigest, decision })
      return decision
    }
  }
  const approve = operator('APPROVED')
  const report: Record<string, unknown> = {
    mode: 'scripted fixture operator', reviews, ...await rowSequence(rows, makeTask('demo-rows', expiresAt), approve),
  }

  const denied = await newPrivateDirectory(root, 'denied')
  const deniedHost = await openFixture(denied, makeTask('demo-denied', expiresAt), operator('DENIED'))
  try {
    const client = deniedHost.clients.get('agent-a')!
    report.denied = await client.submit(await issue(client, 'run-a', { rowIds: [12] }))
    report.deniedEffects = await effectFiles(denied)
  } finally { await deniedHost.close() }

  const unknown = await newPrivateDirectory(root, 'unknown')
  const uncertainTask = makeTask('demo-unknown', expiresAt)
  const uncertainHost = await openFixture(unknown, uncertainTask, approve, true)
  try {
    const client = uncertainHost.clients.get('agent-a')!
    const handle = await issue(client, 'run-a', { rowIds: [1, 2] })
    report.unknown = await client.submit(handle)
    report.unknownReplay = await client.submit(handle)
    report.unknownEffects = await effectFiles(unknown)
  } finally { await uncertainHost.close() }

  const labels = await newPrivateDirectory(root, 'labels')
  const labelHost = await openFixture(labels, makeTask('demo-labels', expiresAt, 'fixture.labels'), approve)
  try {
    const client = labelHost.clients.get('agent-a')!
    report.secondRegistration = await client.submit(await issue(client, 'run-a', { labelIds: [1, 2] }))
    report.labelEffects = await effectFiles(labels)
  } finally { await labelHost.close() }
  return report
}

async function manual(root: string, expiresAt: string) {
  const directory = await newPrivateDirectory(root, 'manual-rows')
  const task = makeTask('manual-rows', expiresAt)
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  try {
    process.stdout.write(`\nManual evidence directory: ${root}\nSelect exact approval on each of the three proposals to demonstrate the shared ten-row cap.\n`)
    const review: Review = async request => {
      process.stdout.write('\nExact synthetic request for operator review\n' + JSON.stringify(request, null, 2) + '\n')
      const challenge = request.requestDigest.slice(-8)
      const answer = (await terminal.question('Enter APPROVE ' + challenge + ', DENY or PENDING: ')).trim()
      if (answer === 'APPROVE ' + challenge) return 'APPROVED'
      if (answer === 'DENY') return 'DENIED'
      return 'PENDING'
    }
    return { mode: 'interactive terminal operator', ...await rowSequence(directory, task, review, terminal) }
  } finally { terminal.close() }
}

async function main(args: string[]) {
  const [mode, directory] = args
  if ((mode !== 'demo' && mode !== 'manual') || args.length > 2) {
    throw new Error('Usage: node src/demo.ts {demo|manual} [new-private-evidence-directory]')
  }
  if (mode === 'manual' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Manual review requires an interactive terminal.')
  }
  const root = await evidenceRoot(directory)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const report = mode === 'manual' ? await manual(root, expiresAt) : await scripted(root, expiresAt)
  const path = join(root, 'report.json')
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(await readFile(path, 'utf8'))
  process.stdout.write('Evidence retained at ' + root + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : 'Pilot failed')
    process.exitCode = 1
  })
}
