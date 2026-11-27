import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadTask, openTask } from './task.mjs';

process.umask(0o077);
const [configFile, principal, ...extra] = process.argv.slice(2);
if (!configFile || !principal || extra.length) throw new Error('Expected a trusted adapter config and binding');

const task = await loadTask(configFile);
const binding = task.config.agents.find(agent => agent.id === principal);
if (!binding || binding.runs.length !== 1) throw new Error('Expected one trusted run for the MCP agent');
const [runId] = binding.runs;
const server = new McpServer({ name: 'leonardo-tales-acp', version: '0.1.0' });
const rows = z.array(z.number().int().min(1).max(30)).min(1).max(30);

function result(payload) {
  return { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

let queued = Promise.resolve();
server.registerTool('synthetic_rows', {
  description: 'Submit bounded synthetic fixture rows. A new request takes rowIds. For review or replay, resubmit the returned operationHandle. The local operator reviews the exact request separately.',
  inputSchema: z.strictObject({
    rowIds: rows.optional(),
    operationHandle: z.string().min(1).max(48).optional(),
  }).refine(args => args.rowIds !== undefined || args.operationHandle !== undefined, {
    message: 'Provide rowIds or an existing operationHandle',
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, args => {
  let operationHandle = args.operationHandle;
  const call = queued.then(async () => {
    const host = await openTask(task);
    try {
      const client = host.clients.get(principal);
      const input = args.rowIds === undefined ? undefined : { rowIds: args.rowIds };
      if (operationHandle === undefined) {
        const created = await client.createOperation(runId, input);
        if (!('operationHandle' in created)) return result({ result: created });
        operationHandle = created.operationHandle;
        return result({ operationHandle, result: await client.submit(operationHandle) });
      }
      return result({ operationHandle, result: await client.submit(operationHandle, input) });
    } finally {
      await host.close();
    }
  }).catch(error => {
    const reason = error.code ?? error.message;
    console.error('ACP request did not complete:', reason);
    const context = operationHandle === undefined ? {} : { operationHandle };
    return {
      ...result({ ...context, error: reason === 'run-not-ready' ? 'run-not-ready' : 'request-incomplete' }),
      isError: true,
    };
  });
  queued = call.then(() => undefined);
  return call;
});

await server.connect(new StdioServerTransport());
