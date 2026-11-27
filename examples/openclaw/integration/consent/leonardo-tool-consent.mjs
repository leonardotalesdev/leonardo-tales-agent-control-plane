import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const toolName = 'leonardo__synthetic_rows';
const sessionKey = 'agent:main:i4-b2';

function isLabRun(context) {
  return context.agentId === 'main' && context.sessionKey === sessionKey
    && typeof context.runId === 'string' && context.runId.length > 0;
}

function callKey(runId, toolCallId) {
  return JSON.stringify([runId, toolCallId]);
}

export default definePluginEntry({
  id: 'leonardo-tool-consent',
  name: 'Leonardo Lab Tool Consent',
  register(api) {
    if (!api.rootDir || !isAbsolute(api.rootDir)) throw new Error('Missing installed plugin root.');
    // The Gateway can load a captured copy of the module. Use the installed plugin root.
    const labRoot = resolve(api.rootDir, '../..');
    const adapterDirectory = join(labRoot, 'integration/mcp');
    const require = createRequire(join(adapterDirectory, 'package.json'));
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transportArgs = [
      '-i', 'PATH=/usr/bin:/bin',
      join(labRoot, 'runtime/node/bin/node'),
      join(adapterDirectory, 'server.mjs'),
      join(labRoot, 'profile/i2-mcp/adapter.json'),
      'openclaw-lab',
    ];

    async function forward(approvedArguments, signal, assertCurrent) {
      signal.throwIfAborted();
      assertCurrent();
      const client = new Client({ name: 'leonardo-lab-tool-consent', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: '/usr/bin/env', args: transportArgs, cwd: adapterDirectory, stderr: 'ignore',
      });
      try {
        await client.connect(transport, { timeout: 15_000, signal });
        signal.throwIfAborted();
        assertCurrent();
        const result = await client.callTool({ name: 'synthetic_rows', arguments: approvedArguments },
          undefined, { timeout: 15_000, signal });
        return {
          content: result.content,
          details: {
            structuredContent: result.structuredContent,
            ...(result.isError === true ? { status: 'error' } : {}),
          },
        };
      } finally {
        await client.close();
      }
    }

    // Each slot connects one OpenClaw decision to the matching tool invocation.
    const calls = new Map();
    api.on('before_tool_call', (event, context) => {
      if (event.toolName !== toolName) return;

      const signal = context.abortSignal;
      if (!isLabRun(context) || !event.toolCallId || !signal || signal.aborted) {
        return { block: true, blockReason: 'The synthetic call has no current lab invocation.' };
      }

      const args = JSON.stringify(event.params);
      if (!args || args.length > 400 || /[^\x20-\x7e]/u.test(args)) {
        return { block: true, blockReason: 'The exact arguments cannot be displayed for consent.' };
      }

      const key = callKey(context.runId, event.toolCallId);
      const pending = calls.get(key);
      if (pending) {
        pending.discard();
        return { block: true, blockReason: 'The synthetic call already has a pending consent binding.' };
      }
      const call = { args, signal, approvedUntil: 0 };
      call.discard = () => {
        if (calls.get(key) === call) calls.delete(key);
        clearTimeout(expiry);
        signal.removeEventListener('abort', call.discard);
      };
      const expiry = setTimeout(call.discard, 100_000);
      expiry.unref?.();
      calls.set(key, call);
      signal.addEventListener('abort', call.discard, { once: true });

      return {
        requireApproval: {
          title: 'Leonardo Lab synthetic rows',
          description: `${toolName} ${args}\nACP operator approval is separate.`,
          severity: 'warning',
          allowedDecisions: ['allow-once', 'deny'],
          timeoutMs: 90_000,
          onResolution(decision) {
            if (calls.get(key) !== call) return;
            if (decision === 'allow-once' && !signal.aborted && call.approvedUntil === 0) {
              call.approvedUntil = performance.now() + 10_000;
            } else {
              call.discard();
            }
          },
        },
      };
    });

    api.registerTool({
      contextVersion: 2,
      create(context) {
        if (!isLabRun(context)) return null;
        return {
          name: toolName,
          label: 'Leonardo Lab synthetic rows',
          description: 'Propose synthetic fixture rows with rowIds, or resume using the original operationHandle. OpenClaw consent and separate ACP operator approval are required.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              rowIds: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 30 }, minItems: 1, maxItems: 30 },
              operationHandle: { type: 'string', minLength: 1, maxLength: 48 },
            },
          },
          async execute(toolCallId, args, signal) {
            const key = callKey(context.runId, toolCallId);
            const call = calls.get(key);
            call?.discard();
            if (!signal || !call || call.approvedUntil <= performance.now() || call.args !== JSON.stringify(args)) {
              throw new Error('This call has no matching one-time OpenClaw approval.');
            }
            const invocationSignal = AbortSignal.any([call.signal, signal]);
            return forward(JSON.parse(call.args), invocationSignal, context.assertInvocationCurrent);
          },
        };
      },
    }, { name: toolName, optional: true, workspaceAccess: false });
  },
});
