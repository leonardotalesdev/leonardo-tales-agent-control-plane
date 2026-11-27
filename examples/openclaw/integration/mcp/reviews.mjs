import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalDigest } from '@leonardo-tales/agent-control-plane/catalog';

export async function readJson(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 65536) {
      throw new Error('Expected a bounded, owner-only JSON record');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

export async function writeOnce(directory, name, value) {
  const temporary = join(directory, '.write-' + randomUUID());
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, join(directory, name));
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return true;
  } finally {
    await unlink(temporary);
  }
}

function fileName(requestId) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(requestId)) {
    throw new Error('Invalid approval request ID');
  }
  return requestId + '.json';
}

export async function getRequest(paths, requestId) {
  return readJson(join(paths.pending, fileName(requestId)));
}

export async function listRequests(paths) {
  const records = [];
  for (const name of (await readdir(paths.pending)).sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const request = await readJson(join(paths.pending, name));
    const decision = await readJson(join(paths.decisions, name));
    records.push({ request, decision, expired: Date.parse(request.expiresAt) <= Date.now() });
  }
  return records;
}

export async function review(paths, request) {
  const name = fileName(request.requestId);
  const binding = canonicalDigest(request);
  if (!await writeOnce(paths.pending, name, request)) {
    const original = await getRequest(paths, request.requestId);
    if (canonicalDigest(original) !== binding) throw new Error('Approval request binding conflict');
  }

  const record = await readJson(join(paths.decisions, name));
  const now = Date.now();
  const expiry = Date.parse(request.expiresAt);
  const recordedAt = Date.parse(record?.recordedAt);
  if (record?.approverId !== request.approverId ||
      record.requestId !== request.requestId ||
      record.requestDigest !== request.requestDigest ||
      record.reviewDigest !== binding ||
      !Number.isFinite(recordedAt) || !Number.isFinite(expiry) ||
      recordedAt > now || recordedAt >= expiry || now >= expiry) return 'PENDING';

  return record.decision === 'APPROVED' || record.decision === 'DENIED' ? record.decision : 'PENDING';
}

export async function recordDecision(paths, approverId, requestId, requestDigest, decision) {
  const request = await getRequest(paths, requestId);
  if (!request || request.requestId !== requestId || request.requestDigest !== requestDigest ||
      request.approverId !== approverId) throw new Error('Approval request or digest does not match');
  if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) {
    throw new Error('Approval request has expired');
  }
  const record = {
    approverId, requestId, requestDigest, reviewDigest: canonicalDigest(request),
    decision, recordedAt: new Date().toISOString(),
  };
  if (!await writeOnce(paths.decisions, fileName(requestId), record)) {
    const existing = await readJson(join(paths.decisions, fileName(requestId)));
    if (existing.approverId !== approverId || existing.requestDigest !== requestDigest ||
        existing.reviewDigest !== record.reviewDigest || existing.decision !== decision) {
      throw new Error('A different operator decision is already recorded');
    }
    return existing;
  }
  return record;
}
