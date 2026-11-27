import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest } from '@leonardo-tales/agent-control-plane/catalog';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mode = process.argv[2];
if (!['stage', 'resume'].includes(mode) || process.argv.length !== 5) {
  console.error('Usage: node verify.mjs stage|resume <adapter.json> <evidence-directory>');
  process.exit(2);
}

process.umask(0o077);
const configPath = resolve(process.argv[3]);
const evidenceDir = resolve(process.argv[4]);
const reviewsDir = join(dirname(configPath), 'reviews');
const stateDir = join(dirname(configPath), 'state');
const stagePath = join(evidenceDir, 'stage.json');
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const toolName = 'synthetic_rows';
const primary = 'openclaw-lab';
const peer = 'verification-peer';
const budget = 'verification-budget';
const requestOptions = { timeout: 15000 };

async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    assert(metadata.isFile() && metadata.uid === process.getuid() && metadata.nlink === 1
      && (metadata.mode & 0o777) === 0o600 && metadata.size <= 65536,
    `Expected an owner-only JSON record at ${path}`);
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

async function saveJson(path, record) {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function withClient(binding, operation) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, configPath, binding],
    stderr: 'inherit',
  });
  const client = new Client({ name: 'leonardo-acp-direct-verification', version: '0.1.0' });
  try {
    await client.connect(transport, requestOptions);
    return await operation(client);
  } finally {
    await client.close();
  }
}

function call(client, args) {
  return client.callTool({ name: toolName, arguments: args }, undefined, requestOptions);
}

async function invoke(client, args) {
  const response = await call(client, args);
  assert(!response.isError, `Tool invocation failed: ${JSON.stringify(response.content)}`);
  assert(response.structuredContent?.result, 'Missing ACP structured result');
  return response.structuredContent;
}

function assertRefusal(response, reason) {
  assert.deepEqual({ decision: response.result.decision, reason: response.result.reason },
    { decision: 'BLOCKED', reason });
}

async function assertSpoofRejected(client) {
  let response;
  try {
    response = await call(client, { rowIds: [1], agentId: peer });
  } catch (error) {
    assert.equal(error.code, -32602, 'Expected invalid parameters from the MCP server');
    return true;
  }
  assert(response.isError || response.structuredContent?.result?.reason === 'invalid-input',
    'The MCP server accepted a model-provided identity field');
  return true;
}

function reviewPath(directory, requestId) {
  assert.match(requestId, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/);
  return join(reviewsDir, directory, `${requestId}.json`);
}

async function pendingReview(client, binding, rowIds) {
  const response = await invoke(client, { rowIds });
  assert.equal(response.result.decision, 'APPROVAL_REQUIRED');
  const { operationHandle, result } = response;
  assert.equal(result.attribution.agentId, binding);
  assert.equal(result.attribution.operationKey, operationHandle);
  assert.equal(result.cap, 10);
  assert.equal(result.requested, rowIds.length);
  assert.equal(result.settled, 0);
  assert.equal(result.held, 0);
  assert.equal(result.remaining, 10);
  const review = await readJson(reviewPath('pending', result.approvalRequestId));
  const reviewDigest = canonicalDigest(review);
  assert.equal(review.requestId, result.approvalRequestId);
  assert.equal(review.operationKey, operationHandle);
  assert.deepEqual(review.attribution, result.attribution);
  assert.deepEqual(review.input.items, rowIds);
  assert.equal(review.amount, rowIds.length);
  assert.equal(review.unit, 'rows');
  assert.equal(review.target, 'synthetic-rows');
  assert.match(review.requestDigest, /^[0-9a-f]{64}$/);
  assert.match(reviewDigest, /^[0-9a-f]{64}$/);
  assert(Date.parse(review.expiresAt) > Date.now(), 'Pending approval expired');
  return { binding, rowIds, operationHandle, receipt: result, review, reviewDigest };
}

async function countFiles(path, prefix) {
  return (await readdir(path)).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort();
}

async function stage() {
  const phases = await withClient(primary, async client => {
    const { tools, nextCursor } = await client.listTools();
    assert.equal(nextCursor, undefined);
    assert.deepEqual(tools.map(tool => tool.name), [toolName]);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), ['operationHandle', 'rowIds']);
    const initialized = { server: client.getServerVersion(), capabilities: client.getServerCapabilities() };
    assert(initialized.server?.name && initialized.capabilities?.tools, 'MCP tool capability was not negotiated');
    const principalSpoofRejected = await assertSpoofRejected(client);
    const policyRefusal = await invoke(client, { rowIds: [30] });
    assertRefusal(policyRefusal, 'policy-block');
    assert.equal(policyRefusal.result.source, 'host-policy');
    assert.equal(policyRefusal.result.attribution.agentId, primary);
    assert(policyRefusal.result.violations.length > 0);
    assert.deepEqual(await countFiles(join(reviewsDir, 'pending'), ''), []);
    assert.deepEqual(await countFiles(stateDir, 'effect-'), []);
    const first = await pendingReview(client, primary, [1, 2, 3, 4]);
    return { initialized, tools, principalSpoofRejected, policyRefusal, first };
  });

  const { unauthorized, second } = await withClient(peer, async client => {
    const unauthorized = await invoke(client, { operationHandle: phases.first.operationHandle });
    assertRefusal(unauthorized, 'forbidden');
    const second = await pendingReview(client, peer, [5, 6, 7]);
    return { unauthorized, second };
  });
  const third = await withClient(budget, client => pendingReview(client, budget, [8, 9, 10, 11]));
  const { first, ...protocol } = phases;
  const pending = [first, second, third];
  assert.equal(new Set(pending.map(entry => entry.receipt.taskId)).size, 1);
  assert.equal(new Set(pending.map(entry => entry.receipt.approvalRequestId)).size, 3);
  assert.deepEqual(await countFiles(stateDir, 'effect-'), []);
  assert.deepEqual(await countFiles(stateDir, 'approval-'), []);
  await saveJson(stagePath, { configPath, ...protocol, unauthorized, pending });
  console.log(`MCP initialization and discovery passed. Policy, unauthorized handle, and pending review checks passed.\n${stagePath}`);
  for (const { review } of pending) {
    console.log(`${review.requestId}  ${review.requestDigest}  expires ${review.expiresAt}`);
  }
}

function assertAccounting(response, { decision, requested, settled, remaining }) {
  assert.deepEqual({
    decision: response.result.decision,
    requested: response.result.requested,
    settled: response.result.settled,
    held: response.result.held,
    remaining: response.result.remaining,
    cap: response.result.cap,
  }, { decision, requested, settled, held: 0, remaining, cap: 10 });
}

function assertAttribution(entry, response) {
  assert.equal(response.operationHandle, entry.operationHandle);
  assert.deepEqual(response.result.attribution, entry.receipt.attribution);
  assert.equal(response.result.approvalRequestId, entry.review.requestId);
  assert.equal(response.result.inputDigest, entry.receipt.inputDigest);
}

async function requireHumanApproval(entry) {
  const { review, reviewDigest } = entry;
  let decision;
  try {
    decision = await readJson(reviewPath('decisions', review.requestId));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Operator approval is missing for ${review.requestId}`);
  }
  assert.equal(decision.decision, 'APPROVED', `Operator did not approve ${review.requestId}`);
  assert.equal(decision.approverId, review.approverId);
  assert.equal(decision.requestId, review.requestId);
  assert.equal(decision.requestDigest, review.requestDigest);
  assert.equal(decision.reviewDigest, reviewDigest);
  assert.equal(canonicalDigest(review), reviewDigest);
  const recordedAt = Date.parse(decision.recordedAt);
  const expiresAt = Date.parse(review.expiresAt);
  const now = Date.now();
  assert(recordedAt < expiresAt && recordedAt <= now && now < expiresAt,
    'Operator record is expired or future-dated');
}

async function assertDurableApproval(entry) {
  const { review, operationHandle } = entry;
  const approval = await readJson(join(stateDir, `approval-${operationHandle}.json`));
  assert.deepEqual({
    approverId: approval.approverId,
    requestId: approval.requestId,
    requestDigest: approval.requestDigest,
    expiresAt: approval.expiresAt,
    decision: approval.decision,
  }, {
    approverId: review.approverId,
    requestId: review.requestId,
    requestDigest: review.requestDigest,
    expiresAt: review.expiresAt,
    decision: 'APPROVED',
  });
  assert(Date.parse(approval.decidedAt) < Date.parse(approval.expiresAt));
  return approval;
}

async function assertDurableEffect(entry, result) {
  const { evidenceId } = result;
  assert.match(evidenceId, /^effect-[a-z0-9-]+$/);
  const effect = await readJson(join(stateDir, `${evidenceId}.json`));
  assert.equal(effect.evidenceId, evidenceId);
  assert.deepEqual(effect.attribution, entry.receipt.attribution);
  assert.deepEqual(effect.effect, { rowIds: entry.rowIds });
  return effect;
}

async function resume() {
  const stageReport = await readJson(stagePath);
  const resumePath = join(evidenceDir, 'resume.json');
  assert.equal(stageReport.configPath, configPath);
  assert.deepEqual(stageReport.pending.map(entry => entry.binding), [primary, peer, budget]);
  const [first, second, third] = stageReport.pending;
  for (const entry of stageReport.pending) await requireHumanApproval(entry);
  await assert.rejects(stat(resumePath), { code: 'ENOENT' }, 'Verification evidence already exists');

  const firstResponse = await withClient(primary, client => invoke(client, { operationHandle: first.operationHandle }));
  assertAccounting(firstResponse, { decision: 'EXECUTED', requested: 4, settled: 4, remaining: 6 });
  assertAttribution(first, firstResponse);

  const { unauthorized, secondResponse } = await withClient(peer, async client => {
    const unauthorized = await invoke(client, { operationHandle: first.operationHandle });
    assertRefusal(unauthorized, 'forbidden');
    const secondResponse = await invoke(client, { operationHandle: second.operationHandle });
    return { unauthorized, secondResponse };
  });
  assertAccounting(secondResponse, { decision: 'EXECUTED', requested: 3, settled: 7, remaining: 3 });
  assertAttribution(second, secondResponse);

  const capRefusal = await withClient(budget, async client => {
    const capRefusal = await invoke(client, { operationHandle: third.operationHandle });
    assertRefusal(capRefusal, 'task_limit');
    assertAccounting(capRefusal, { decision: 'BLOCKED', requested: 4, settled: 7, remaining: 3 });
    assertAttribution(third, capRefusal);
    assert.equal(capRefusal.result.refusalBasis.requested, 4);
    assert.equal(capRefusal.result.refusalBasis.remaining, 3);
    assert.equal(capRefusal.result.evidenceId, null);
    return capRefusal;
  });

  const { replay, conflict } = await withClient(primary, async client => {
    const beforeReplay = await countFiles(stateDir, 'effect-');
    assert.equal(beforeReplay.length, 2);
    const replay = await invoke(client, { operationHandle: first.operationHandle, rowIds: first.rowIds });
    assert.equal(replay.result.decision, 'EXECUTED');
    assert.equal(replay.result.replayed, true);
    assert.equal(replay.result.evidenceId, firstResponse.result.evidenceId);
    assertAttribution(first, replay);
    assert.deepEqual(await countFiles(stateDir, 'effect-'), beforeReplay);

    const conflict = await invoke(client, { operationHandle: first.operationHandle, rowIds: [1, 2, 3] });
    assert.equal(conflict.result.decision, 'CONFLICT');
    assert.equal(conflict.result.reason, 'operation-conflict');
    assert.deepEqual(await countFiles(stateDir, 'effect-'), beforeReplay);
    return { replay, conflict };
  });

  const approvals = await Promise.all(stageReport.pending.map(assertDurableApproval));
  const effects = await Promise.all([
    assertDurableEffect(first, firstResponse.result),
    assertDurableEffect(second, secondResponse.result),
  ]);
  const accessFiles = await countFiles(stateDir, 'access-');
  const access = await Promise.all(accessFiles.map(name => readJson(join(stateDir, name))));
  for (const entry of stageReport.pending) {
    assert(access.some(record => record.kind === 'resume' && record.operationHandle === entry.operationHandle
      && record.requesterId === entry.binding && record.runId === entry.receipt.runId),
    'ACP did not retain original requester evidence for a resumed request');
  }
  assert(access.some(record => record.kind === 'replay' && record.operationHandle === first.operationHandle
    && record.requesterId === primary && record.runId === first.receipt.runId),
  'ACP did not retain replay access evidence');
  assert(!access.some(record => record.operationHandle === first.operationHandle && record.requesterId === peer));
  await saveJson(resumePath, {
    configPath, first: firstResponse, second: secondResponse, capRefusal, unauthorized, replay, conflict,
    approvals, effects, access,
  });
  console.log(`Exact human approval, shared Task cap, durable attribution and replay checks passed.\n${resumePath}`);
}

if (mode === 'stage') {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const metadata = await stat(evidenceDir);
  assert(metadata.isDirectory() && metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0,
    'Evidence directory must be owner-only');
  await stage();
} else {
  await resume();
}
