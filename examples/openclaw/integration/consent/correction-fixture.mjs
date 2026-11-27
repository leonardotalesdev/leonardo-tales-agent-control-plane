import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./package.json', import.meta.url));
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const [adapterPath, principal] = process.argv.slice(2);
const { receiptFile } = JSON.parse(readFileSync(adapterPath, 'utf8'));

function record(event) {
  appendFileSync(receiptFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

record({ type: 'start', pid: process.pid, principal });
const server = new McpServer({ name: 'inert-consent-fixture', version: '1.0.0' });
server.registerTool('synthetic_rows', {
  description: 'Record exact forwarded arguments for the inert test',
  inputSchema: z.strictObject({
    rowIds: z.array(z.number().int()).optional(),
    operationHandle: z.string().optional(),
  }),
}, args => {
  record({ type: 'call', args });
  const operationHandle = args.operationHandle ?? 'op-inert-consent-fixture';
  const payload = {
    operationHandle,
    result: {
      runId: 'openclaw-mcp-run', operationKey: operationHandle, cap: 10, settled: 0, held: 0,
      remaining: 10, decision: 'APPROVAL_REQUIRED',
      attribution: { agentId: principal, runId: 'openclaw-mcp-run' },
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
});

await server.connect(new StdioServerTransport());
