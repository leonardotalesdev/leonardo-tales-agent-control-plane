import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { openHost } from '@leonardo-tales/agent-control-plane';
import { readJson, review, writeOnce } from './reviews.mjs';

const configName = 'adapter.json';
const actionId = 'fixture.rows';
const actionRevision = 1;

function taskPaths(root) {
  return {
    state: join(root, 'state'),
    pending: join(root, 'reviews', 'pending'),
    decisions: join(root, 'reviews', 'decisions'),
  };
}

async function checkPrivateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Task state and review directories must be private and owned by this user');
  }
}

export async function initializeTask(directory, verification = false) {
  await mkdir(directory, { mode: 0o700 });
  const root = await realpath(directory);
  const paths = taskPaths(root);
  await mkdir(join(root, 'reviews'), { mode: 0o700 });
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
  const config = {
    task: {
      id: 'lt-i2-' + randomBytes(6).toString('hex'),
      purpose: 'Leonardo Tales I2 local synthetic MCP fixture',
      ownerId: 'lab-owner',
      cap: 10,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actionId, actionRevision,
    },
    agents: [{ id: 'openclaw-lab', runs: ['openclaw-mcp-run'] }],
    approverId: 'lab-operator',
  };
  if (verification) {
    config.agents.push(
      { id: 'verification-peer', runs: ['verification-peer-run'] },
      { id: 'verification-budget', runs: ['verification-budget-run'] },
    );
  }
  const host = await openHost({ ...config, directory: paths.state, review: async () => 'PENDING' });
  await host.close();
  await writeOnce(root, configName, config);
  return join(root, configName);
}

export async function loadTask(configFile) {
  if (!isAbsolute(configFile) || basename(configFile) !== configName) {
    throw new Error('Use the absolute path to an operator-initialized adapter.json');
  }
  const root = await realpath(dirname(configFile));
  const trustedFile = join(root, configName);
  await checkPrivateDirectory(root);
  const info = await lstat(trustedFile);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('The adapter config must be a private file owned by this user');
  }
  const config = await readJson(trustedFile);
  if (config?.task?.actionId !== actionId || config.task.actionRevision !== actionRevision) {
    throw new Error('Only the pinned synthetic fixture is supported');
  }
  const paths = taskPaths(root);
  await checkPrivateDirectory(join(root, 'reviews'));
  for (const path of Object.values(paths)) await checkPrivateDirectory(path);
  return { config, paths };
}

export async function openTask({ config, paths }) {
  if ((await readdir(paths.state)).length === 0) {
    throw new Error('The operator-initialized ACP state is missing');
  }
  return openHost({ ...config, directory: paths.state, review: request => review(paths, request) });
}
