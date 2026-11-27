import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = '../../runtime/npm/lib/node_modules/openclaw/dist/';
const pluginId = 'leonardo-tool-consent';
const toolName = 'leonardo__synthetic_rows';
const sessionKey = 'agent:main:i4-b2';
const scratch = await mkdtemp(join(tmpdir(), 'leonardo-consent-correction-'));
const cases = {};

async function verify() {
  const workspace = join(scratch, 'workspace');
  const agentDir = join(scratch, 'agent');
  const plugin = join(scratch, 'integration/consent');
  const mcp = join(scratch, 'integration/mcp');
  const node = join(scratch, 'runtime/node/bin');
  const adapter = join(scratch, 'profile/i2-mcp');
  const receipts = join(scratch, 'receipts.jsonl');
  const configPath = join(scratch, 'openclaw.json');
  await Promise.all([workspace, agentDir, plugin, mcp, node, adapter].map(path => mkdir(path, { recursive: true })));
  const pluginFiles = ['package.json', 'openclaw.plugin.json', 'leonardo-tool-consent.mjs'];
  await Promise.all([
    ...pluginFiles.map(name => copyFile(join(root, 'integration/consent', name), join(plugin, name))),
    copyFile(join(root, 'integration/consent/correction-fixture.mjs'), join(mcp, 'server.mjs')),
    copyFile(join(root, 'integration/mcp/package.json'), join(mcp, 'package.json')),
    symlink(join(root, 'integration/mcp/node_modules'), join(mcp, 'node_modules')),
    symlink(process.execPath, join(node, 'node')),
    writeFile(join(adapter, 'adapter.json'), JSON.stringify({ receiptFile: receipts })),
    writeFile(receipts, ''),
  ]);

  const live = JSON.parse(await readFile(join(root, 'profile/openclaw.json'), 'utf8'));
  const installed = JSON.parse(await readFile(join(root, 'runtime/npm/lib/node_modules/openclaw/package.json'), 'utf8'));
  assert.equal(installed.version, '2026.11.10');
  assert.deepEqual(Object.values(live.mcp.servers).map(server => server.enabled), [false]);
  assert.deepEqual(live.tools.gatewayPolicy.allow, []);
  assert.ok(!live.tools.alsoAllow.includes(toolName));
  assert.ok(live.plugins.allow.includes(pluginId));
  assert.deepEqual(live.plugins.load.paths, [join(root, 'integration/consent')]);
  assert.equal(live.plugins.entries[pluginId].enabled, true);

  const labConfig = {
    agents: { defaults: { workspace }, entries: { main: { workspace, agentDir } } },
    plugins: {
      enabled: true, allow: [pluginId], slots: { memory: 'none' }, load: { paths: [plugin] },
      entries: { [pluginId]: live.plugins.entries[pluginId] },
    },
    mcp: { servers: { leonardo: {
      enabled: false,
      command: join(node, 'node'),
      args: [join(mcp, 'server.mjs'), join(adapter, 'adapter.json'), 'openclaw-lab'],
      cwd: mcp,
    } } },
    tools: live.tools,
    channels: {},
    cron: { enabled: false },
  };
  const testConfig = {
    ...labConfig,
    tools: { ...live.tools, alsoAllow: [toolName], gatewayPolicy: { allow: [toolName] } },
  };
  await writeFile(configPath, JSON.stringify(testConfig));
  Object.assign(process.env, {
    HOME: scratch, OPENCLAW_HOME: scratch, OPENCLAW_STATE_DIR: scratch, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1', OPENCLAW_OFFLINE: '1', TMPDIR: scratch,
  });

  const { n: createCodingTools } = await import(`${dist}agent-tools.async-Cu9hozum.mjs`);
  const { createBundleMcpToolRuntime } = await import(`${dist}agents/agent-bundle-mcp-materialize.js`);
  const { n: setEmbeddedMode } = await import(`${dist}embedded-mode-CWH0_8k1.mjs`);
  const { i: setBroker, n: clearBroker, t: ApprovalBroker } = await import(`${dist}embedded-plugin-approval-broker-BEtSVTTi.mjs`);
  const { a: initializeHookRunner, o: resetHookRunner } = await import(`${dist}hook-runner-global-Z8lSXQiT.mjs`);
  const { r: loadRegistry } = await import(`${dist}loader-runtime-load-Cir2aYCp.mjs`);
  const { i: getPluginToolMeta } = await import(`${dist}tool-metadata-Cb5nBZYD.mjs`);
  const { t: AsyncWorkScope } = await import(`${dist}async-work-scope-D40kkw8R.mjs`);
  const { E: retireRegistry } = await import(`${dist}registry-lifecycle-iKn_abgq.mjs`);

  const events = () => readFileSync(receipts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const cleanup = [];
  let invocationCurrent = true;
  async function assemble(config, key = sessionKey, runId = 'fixture-run') {
    return createCodingTools({
      config, agentId: 'main', sessionKey: key, runSessionKey: key, sessionId: 'fixture-session', runId,
      trigger: 'user', workspaceDir: workspace, cwd: workspace, agentDir,
      modelProvider: 'openai', modelId: 'gpt-6.1-sol',
      assertInvocationCurrent: () => assert.ok(invocationCurrent, 'Fixture invocation expired'),
      registerRunCleanup: callback => cleanup.push(callback),
    });
  }

  const scope = new AsyncWorkScope();
  let onRequest;
  const broker = new ApprovalBroker(({ event, payload }) => {
    if (event === 'plugin.approval.requested') onRequest?.(payload);
  });
  setEmbeddedMode(true);
  setBroker(broker);
  let registry;
  try {
    const disabled = structuredClone(testConfig);
    disabled.plugins.entries[pluginId].enabled = false;
    const absent = structuredClone(testConfig);
    absent.plugins.load.paths = [];
    assert.deepEqual(await assemble(disabled), []);
    assert.deepEqual(await assemble(absent), []);
    assert.deepEqual(await assemble(labConfig), []);
    assert.deepEqual(await assemble(testConfig, 'agent:main:wrong-session'), []);
    const direct = await createBundleMcpToolRuntime({ cfg: testConfig, workspaceDir: workspace });
    try { assert.deepEqual(direct.appTools, []); }
    finally { await direct.dispose(); }
    assert.deepEqual(events(), []);
    cases.exposure = { absent: 0, disabled: 0, wrongSession: 0, liveGate: 0, directMcp: 0 };

    registry = await loadRegistry({ config: testConfig, workspaceDir: workspace, onlyPluginIds: [pluginId], throwOnLoadError: true });
    const registrations = registry.typedHooks.filter(hook => hook.pluginId === pluginId);
    assert.deepEqual(registrations.map(hook => hook.hookName), ['before_tool_call']);
    assert.deepEqual(registry.tools.map(registration => registration.pluginId), [pluginId]);
    initializeHookRunner(registry);
    const tools = await assemble(testConfig);
    assert.deepEqual(tools.map(tool => tool.name), [toolName]);
    const [tool] = tools;
    assert.equal(getPluginToolMeta(tool).pluginId, pluginId);
    cases.registration = { count: 1, owner: pluginId, name: toolName, source: 'plugin' };

    function execute(id, args, signal = new AbortController().signal) {
      return scope.run(() => tool.execute(id, args, signal));
    }
    async function pending(id, args, signal) {
      const waiting = Promise.withResolvers();
      onRequest = waiting.resolve;
      const result = execute(id, args, signal);
      const request = await Promise.race([waiting.promise, result.then(() => {
        throw new Error(`No approval request for ${id}`);
      })]);
      onRequest = undefined;
      assert.deepEqual(request.request.allowedDecisions, ['allow-once', 'deny']);
      assert.equal(request.request.pluginId, pluginId);
      assert.equal(request.request.toolName, toolName);
      assert.equal(request.request.toolCallId, id);
      assert.equal(request.request.sessionKey, sessionKey);
      assert.ok(request.request.description.includes(JSON.stringify(args)));
      assert.equal(request.expiresAtMs - request.createdAtMs, 90_000);
      return { request, result };
    }
    function noForwarding(beginning) {
      assert.equal(events().length, beginning, 'No fixture child should start or receive a call');
    }

    const args = { rowIds: [1, 2] };
    const proposal = await pending('proposal', args);
    noForwarding(0);
    assert.equal(broker.resolve(proposal.request.id, 'allow-always'), false);
    assert.equal(broker.resolve(proposal.request.id, 'malformed-decision'), false);
    noForwarding(0);
    args.rowIds.push(7);
    assert.equal(broker.resolve(proposal.request.id, 'allow-once'), true);
    assert.equal(broker.resolve(proposal.request.id, 'allow-once'), false);
    const result = await proposal.result;
    assert.equal(events().length, 2);
    assert.equal(events()[0].principal, 'openclaw-lab');
    assert.deepEqual(events()[1], { type: 'call', args: { rowIds: [1, 2] } });
    const payload = {
      operationHandle: 'op-inert-consent-fixture',
      result: {
        runId: 'openclaw-mcp-run', operationKey: 'op-inert-consent-fixture', cap: 10, settled: 0, held: 0,
        remaining: 10, decision: 'APPROVAL_REQUIRED',
        attribution: { agentId: 'openclaw-lab', runId: 'openclaw-mcp-run' },
      },
    };
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(payload) }]);
    assert.deepEqual(result.details.structuredContent, payload);
    cases.allowOnce = { forwards: 1, args: { rowIds: [1, 2] }, duplicateResolutionRefused: true, unchangedAdapterPayload: true };
    cases.persistent = { offered: false, rejected: true, forwards: 0 };

    const handle = { operationHandle: payload.operationHandle };
    const denied = await pending('resume-denied', handle);
    assert.notEqual(denied.request.id, proposal.request.id);
    assert.equal(broker.resolve(denied.request.id, 'deny'), true);
    await assert.rejects(denied.result, /Denied by user/i);
    noForwarding(2);
    const resume = await pending('resume-allowed', handle);
    assert.notEqual(resume.request.id, denied.request.id);
    noForwarding(2);
    assert.equal(broker.resolve(resume.request.id, 'allow-once'), true);
    await resume.result;
    assert.deepEqual(events().at(-1), { type: 'call', args: handle });
    cases.resume = { originalHandle: handle.operationHandle, freshRequests: true, deniedForwards: 0, allowedForwards: 1 };

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const timed = await pending('timeout', handle);
      mock.timers.tick(90_000);
      await assert.rejects(timed.result, /Approval timed out/i);
      assert.equal(broker.resolve(timed.request.id, 'allow-once'), false);
      noForwarding(4);
    } finally { mock.timers.reset(); }
    cases.timeout = { simulatedClock: true, forwards: 0 };

    const abort = new AbortController();
    const cancelled = await pending('cancel', handle, abort.signal);
    abort.abort();
    await assert.rejects(cancelled.result, /Approval cancelled|operation was aborted/i);
    assert.equal(broker.resolve(cancelled.request.id, 'allow-once'), false);
    noForwarding(4);
    cases.cancellation = { forwards: 0 };

    const malformed = mock.method(broker, 'request', async () => ({ decision: { invalid: 'allow-once' } }));
    try { await assert.rejects(execute('malformed', handle), /Approval timed out|malformed/i); }
    finally { malformed.mock.restore(); }
    noForwarding(4);
    cases.malformed = { simulatedBrokerResponse: true, forwards: 0 };

    clearBroker(broker);
    setEmbeddedMode(false);
    await assert.rejects(execute('missing-route', handle), /no approval-capable initiating surface/i);
    noForwarding(4);
    setEmbeddedMode(true);
    setBroker(broker);
    cases.missingRoute = { forwards: 0 };

    resetHookRunner();
    await assert.rejects(execute('resume-allowed', handle), /no matching one-time OpenClaw approval/i);
    noForwarding(4);
    cases.hookSkipped = { consumedPermitCannotBeReused: true, forwards: 0 };

    const [registration] = registrations;
    initializeHookRunner({ ...registry, typedHooks: [{ ...registration, handler() { throw new Error('Inert hook fault'); } }] });
    await assert.rejects(execute('hook-fault', handle), /before_tool_call hook failed/i);
    noForwarding(4);
    initializeHookRunner({ ...registry, typedHooks: [{ ...registration, async handler(...input) {
      const request = await registration.handler(...input);
      request.requireApproval.onResolution = () => { throw new Error('Inert resolution fault'); };
      return request;
    } }] });
    const faulty = await pending('resolution-fault', handle);
    assert.equal(broker.resolve(faulty.request.id, 'allow-once'), true);
    await assert.rejects(faulty.result, /no matching one-time OpenClaw approval/i);
    noForwarding(4);
    cases.pluginFailure = { hookFaultForwards: 0, resolutionFaultForwards: 0 };

    initializeHookRunner({ ...registry, typedHooks: [{ ...registration, async handler(...input) {
      const request = await registration.handler(...input);
      return { ...request, params: { operationHandle: 'injected-unreviewed-argument' } };
    } }] });
    const mismatched = await pending('argument-mismatch', handle);
    assert.equal(broker.resolve(mismatched.request.id, 'allow-once'), true);
    await assert.rejects(mismatched.result, /no matching one-time OpenClaw approval/i);
    noForwarding(4);
    cases.invocationBinding = { changedEffectiveArgsRejected: true, forwards: 0 };

    initializeHookRunner(registry);
    const expired = await pending('invocation-expired', handle);
    invocationCurrent = false;
    assert.equal(broker.resolve(expired.request.id, 'allow-once'), true);
    await assert.rejects(expired.result, /Fixture invocation expired/i);
    noForwarding(4);
    invocationCurrent = true;
    retireRegistry(registry);
    resetHookRunner();
    await assert.rejects(execute('retired-tool', handle), /no longer active|retired|has been released/i);
    noForwarding(4);
    cases.retirement = { expiredInvocationForwards: 0, retiredPluginForwards: 0 };

    const children = events().filter(event => event.type === 'start');
    assert.equal(children.length, 2);
    for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    return {
      openclaw: installed.version, node: process.versions.node, modelRequests: 0,
      toolAssembly: 'Pinned embedded coding-tools constructor, plugin registry and async work scope',
      approvalSource: 'Simulated decisions through pinned embedded approval broker',
      stdioFixture: true, fixtureChildrenExited: true, actualAcpEffects: 0,
      cases,
    };
  } finally {
    onRequest = undefined;
    clearBroker(broker);
    broker.stop();
    setEmbeddedMode(false);
    resetHookRunner();
    await Promise.allSettled(cleanup.map(callback => callback('fixture')));
    await scope.drain();
  }
}

try {
  console.log(JSON.stringify(await verify(), null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
