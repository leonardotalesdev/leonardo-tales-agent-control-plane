import { resolve } from 'node:path';
import { initializeTask, loadTask } from './task.mjs';
import { getRequest, listRequests, recordDecision } from './reviews.mjs';

process.umask(0o077);
const [command, path, requestId, requestDigest, ...extra] = process.argv.slice(2);
const usage = 'Expected init|init-verification DIR, list CONFIG, show CONFIG ID, or approve|deny CONFIG ID DIGEST';

async function main() {
  if (!path || extra.length) throw new Error(usage);
  switch (command) {
    case 'init':
    case 'init-verification':
      if (requestId) break;
      return initializeTask(resolve(path), command === 'init-verification');
    case 'list':
      if (requestId) break;
      return listRequests((await loadTask(resolve(path))).paths);
    case 'show': {
      if (!requestId || requestDigest) break;
      const request = await getRequest((await loadTask(resolve(path))).paths, requestId);
      if (!request) throw new Error('Approval request not found');
      return request;
    }
    case 'approve':
    case 'deny': {
      if (!requestId || !requestDigest) break;
      const { config, paths } = await loadTask(resolve(path));
      return recordDecision(paths, config.approverId, requestId, requestDigest, command === 'approve' ? 'APPROVED' : 'DENIED');
    }
  }
  throw new Error(usage);
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
