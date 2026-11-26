import { createHash } from 'node:crypto'
import type { ActionInput } from '@leonardo-tales/action-gateway'
import { REGISTERED_ACTION_PROFILES } from '@leonardo-tales/policy-engine'

export type ActionRegistration = Readonly<{
  id: string
  revision: number
  unit: string
  policy: Readonly<{
    version: string
    target: string
    description: string
    permissionTier: 2
    riskHints: readonly ['medium']
    allowedItems: readonly number[]
    blockedItems: readonly number[]
  }>
  normalize(input: unknown): number[]
  perform(items: readonly number[]): ActionInput
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new Error('expected an enumerable data field')
  }
  return descriptor.value
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && Reflect.ownKeys(value).length === fields.length &&
    fields.every(field => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      return descriptor?.enumerable === true && 'value' in descriptor
    })
}

function arrayValues(value: unknown): unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new Error('expected a dense array')
  }
  return Array.from({ length: value.length }, (_, index) => ownValue(value, String(index)))
}

function itemIds(value: unknown): number[] {
  const items = arrayValues(value)
  const result: number[] = []
  const seen = new Set<number>()
  for (const id of items) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) {
      throw new Error('expected distinct positive safe integer item IDs')
    }
    seen.add(id)
    result.push(id)
  }
  return result
}

function canonicalJson(value: unknown, active: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || value === null || active.has(value)) throw new Error('expected acyclic JSON')
  active.add(value)
  try {
    if (Array.isArray(value)) {
      return '[' + arrayValues(value).map(item => canonicalJson(item, active)).join(',') + ']'
    }
    if (!isRecord(value)) throw new Error('expected a plain JSON record')
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) throw new Error('expected string JSON keys')
    return '{' + (keys as string[]).sort().map(key =>
      JSON.stringify(key) + ':' + canonicalJson(ownValue(value, key), active),
    ).join(',') + '}'
  } finally {
    active.delete(value)
  }
}

/** Hash local host evidence. Gateway generates and verifies its own request digests. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value, new Set())).digest('hex')
}

class Catalog implements ReadonlyMap<string, ActionRegistration> {
  readonly #entries: Map<string, ActionRegistration>

  constructor(entries: Map<string, ActionRegistration>) { this.#entries = entries }
  get size() { return this.#entries.size }
  get(key: string) { return this.#entries.get(key) }
  has(key: string) { return this.#entries.has(key) }
  entries() { return this.#entries.entries() }
  keys() { return this.#entries.keys() }
  values() { return this.#entries.values() }
  [Symbol.iterator]() { return this.entries() }
  forEach(callback: (value: ActionRegistration, key: string, map: ReadonlyMap<string, ActionRegistration>) => void, thisArg?: unknown) {
    for (const [key, value] of this.#entries) callback.call(thisArg, value, key, this)
  }
}

export function createCatalog(registrations: readonly ActionRegistration[]): ReadonlyMap<string, ActionRegistration> {
  const entries = new Map<string, ActionRegistration>()
  for (const registration of registrations) {
    if (!exactFields(registration, ['id', 'revision', 'unit', 'policy', 'normalize', 'perform'])) {
      throw new Error('invalid action registration fields')
    }
    const { id, revision, unit, policy, normalize, perform } = registration
    if (typeof id !== 'string' || id.length > 256 || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id)
      || typeof unit !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(unit)
      || !Number.isSafeInteger(revision) || revision < 1 || typeof normalize !== 'function' || typeof perform !== 'function') {
      throw new Error('invalid action registration')
    }
    if (REGISTERED_ACTION_PROFILES.some(profile => profile === id)) {
      throw new Error('named policy profiles are outside the local catalog')
    }
    const key = id + '@' + revision
    if (entries.has(key)) throw new Error('duplicate action registration')
    if (!exactFields(policy, ['version', 'target', 'description', 'permissionTier', 'riskHints', 'allowedItems', 'blockedItems'])
      || ![policy.version, policy.target, policy.description].every(
      field => typeof field === 'string' && field.trim().length > 0 && field.length <= 256,
    ) || policy.permissionTier !== 2 || policy.riskHints?.length !== 1 || policy.riskHints[0] !== 'medium') {
      throw new Error('invalid fixture policy')
    }
    const allowedItems = Object.freeze(itemIds(policy.allowedItems))
    const blockedItems = Object.freeze(itemIds(policy.blockedItems))
    if (allowedItems.length === 0 || blockedItems.some(item => !allowedItems.includes(item))) {
      throw new Error('invalid fixture policy item sets')
    }
    const snapshot = Object.freeze({
      version: policy.version, target: policy.target, description: policy.description,
      permissionTier: 2 as const, riskHints: Object.freeze(['medium'] as const), allowedItems, blockedItems,
    })
    entries.set(key, Object.freeze({
      id, revision, unit, policy: snapshot, perform,
      normalize(input: unknown) {
        const ids = itemIds(normalize(input))
        if (!ids.length || ids.some(item => !allowedItems.includes(item))) throw new Error('unknown or empty fixture items')
        return ids
      },
    }))
  }
  return Object.freeze(new Catalog(entries))
}

function fixture(id: string, field: string, unit: string, target: string): ActionRegistration {
  return {
    id, revision: 1, unit,
    policy: {
      version: 'fixture-policy-v1', target, description: 'Project synthetic fixture IDs into the local effect record.',
      permissionTier: 2, riskHints: ['medium'], allowedItems: Array.from({ length: 30 }, (_, i) => i + 1),
      blockedItems: [30],
    },
    normalize(input: unknown) {
      if (!isRecord(input) || Reflect.ownKeys(input).length !== 1) throw new Error('invalid fixture input')
      return itemIds(ownValue(input, field))
    },
    perform(items) { return { [field]: [...items] } },
  }
}

export const fixtureCatalog = createCatalog([
  fixture('fixture.rows', 'rowIds', 'rows', 'synthetic-rows'),
  fixture('fixture.labels', 'labelIds', 'labels', 'synthetic-labels'),
])
