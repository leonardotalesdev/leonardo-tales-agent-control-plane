import assert from 'node:assert/strict'
import { mkdtemp, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCatalog, fixtureCatalog, type ActionRegistration } from '../src/catalog.ts'
import { openHost } from '../src/host.ts'

const tiles: ActionRegistration = {
  id: 'fixture.tiles',
  revision: 2,
  unit: 'tiles',
  policy: {
    version: 'fixture-policy-v1',
    target: 'synthetic-tiles',
    description: 'Project IDs from a synthetic tile collection into a local effect record.',
    permissionTier: 2,
    riskHints: ['medium'],
    allowedItems: [1, 2, 3],
    blockedItems: [3],
  },
  normalize(input) {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 1) throw new Error('expected only tileIds')
    const field = Object.getOwnPropertyDescriptor(input, 'tileIds')
    const tileIds: unknown = field?.enumerable && 'value' in field ? field.value : undefined
    if (!Array.isArray(tileIds)) throw new Error('expected a tileIds array')
    // The catalog then checks density, integer IDs, uniqueness and the allowed set.
    return tileIds
  },
  perform(items) {
    return { tileIds: [...items] }
  },
}

const directory = await mkdtemp(join(await realpath(tmpdir()), 'core-pilot-registration-'))
const host = await openHost({
  directory,
  catalog: createCatalog([...fixtureCatalog.values(), tiles]),
  task: {
    id: 'tile-task',
    purpose: 'Export a bounded set of synthetic tiles.',
    ownerId: 'example-owner',
    actionId: tiles.id,
    actionRevision: tiles.revision,
    cap: 2,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
  agents: [{ id: 'example-agent', runs: ['tile-run'] }],
  approverId: 'example-reviewer',
  async review(request) {
    // This callback is a scripted operator fixture. Only the host can invoke it.
    assert.equal(request.target, tiles.policy.target)
    assert.deepEqual(request.input.items, [1])
    assert.equal(request.amount, 1)
    return 'APPROVED'
  },
})

try {
  const client = host.clients.get('example-agent')!
  async function propose(tileIds: number[]) {
    const proposal = await client.createOperation('tile-run', { tileIds })
    return 'operationHandle' in proposal ? client.submit(proposal.operationHandle) : proposal
  }

  const offList = await propose([4])
  const policyRefusal = await propose([3])
  const approved = await propose([1])
  const effects = (await readdir(directory)).filter(name => name.startsWith('effect-'))

  assert.equal(offList.reason, 'invalid-input')
  assert.equal(policyRefusal.reason, 'policy-block')
  assert.equal(approved.decision, 'EXECUTED')
  assert.ok('inputDigest' in approved)
  assert.deepEqual([approved.requested, approved.settled, approved.held, approved.remaining], [1, 1, 0, 1])
  assert.equal(effects.length, 1)
  console.log(JSON.stringify({
    mode: 'scripted fixture operator',
    directory, offList, policyRefusal, approved, effects,
  }, null, 2))
} finally {
  await host.close()
}
