import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const maxRecordBytes = 64 * 1024
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function serialize(value: unknown): Buffer {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'object') return item
    throw new Error('invalid-store-json')
  })
  const bytes = Buffer.from(json + '\n', 'utf8')
  if (bytes.length > maxRecordBytes) throw new Error('store-record-too-large')
  return bytes
}

export async function openStore(directory: string) {
  const parent = dirname(directory)
  if (!isAbsolute(directory) || resolve(directory) !== directory || parent === directory ||
      await realpath(parent) !== parent) throw new Error('invalid-store-directory')

  try {
    await mkdir(directory, { mode: 0o700 })
    const parentHandle = await open(parent, directoryFlags)
    try { await parentHandle.sync() } finally { await parentHandle.close() }
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  const root = await open(directory, directoryFlags)
  const lockPath = join(directory, '.pilot-store.lock')
  const uid = process.getuid?.()
  try {
    const stat = await root.stat()
    if (uid === undefined || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
      throw new Error('unsafe-store-directory')
    }
    const lock = await open(lockPath, 'wx', 0o600)
    try { await lock.sync() } finally { await lock.close() }
    await root.sync()
  } catch (error) {
    await root.close()
    if (hasCode(error, 'EEXIST')) throw new Error('store-locked')
    throw error
  }

  let tail = Promise.resolve()
  let closing: Promise<void> | undefined
  let uncertain = false

  function run<T>(action: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('store-closed'))
    const result = tail.then(() => {
      if (uncertain) throw new Error('store-write-uncertain')
      return action()
    })
    tail = result.then(() => {}, () => {})
    return result
  }

  function recordPath(name: string): string {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(name)) {
      throw new Error('invalid-store-name')
    }
    return join(directory, name)
  }

  async function readBytes(path: string): Promise<Buffer | null> {
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if (hasCode(error, 'ENOENT')) return null
      throw error
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
        throw new Error('unsafe-store-record')
      }
      if (stat.size > maxRecordBytes) throw new Error('store-record-too-large')
      const bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset !== stat.size) throw new Error('store-record-changed')
      return bytes.subarray(0, offset)
    } finally { await file.close() }
  }

  async function writeBytes(path: string, bytes: Buffer, replace = false): Promise<void> {
    const temporary = join(directory, '.tmp-' + randomUUID())
    const file = await open(temporary, 'wx', 0o600)
    let published = false
    try {
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally { await file.close() }
      if (replace) {
        await rename(temporary, path)
        published = true
      } else {
        // link publishes a complete inode and refuses to replace an existing name.
        await link(temporary, path)
        published = true
        await unlink(temporary)
      }
      await root.sync()
    } catch (error) {
      if (published) uncertain = true
      else await unlink(temporary)
      throw error
    }
  }

  return {
    read<T>(name: string): Promise<T | null> {
      return run(async () => {
        const bytes = await readBytes(recordPath(name))
        return bytes === null ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T
      })
    },
    create(name: string, value: unknown): Promise<void> {
      return run(() => writeBytes(recordPath(name), serialize(value)))
    },
    replace(name: string, value: unknown): Promise<void> {
      return run(() => writeBytes(recordPath(name), serialize(value), true))
    },
    ensure(name: string, value: unknown): Promise<void> {
      return run(async () => {
        const path = recordPath(name)
        const bytes = serialize(value)
        const previous = await readBytes(path)
        if (previous === null) await writeBytes(path, bytes)
        else if (!previous.equals(bytes)) throw new Error('store-record-conflict')
      })
    },
    close(): Promise<void> {
      closing ??= tail.then(async () => {
        try {
          if (uncertain) throw new Error('store-write-uncertain')
          await unlink(lockPath)
          await root.sync()
        } finally { await root.close() }
      })
      return closing
    },
  }
}
