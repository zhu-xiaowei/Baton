import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExecutable } from './platform.mjs';
import { binaryVersion, resolveCodexBin } from './runtime-capabilities.mjs';

const cache = new Map();

export async function probeCodexArchiveProtocol() {
  const binary = resolveCodexBin();
  if (!binary) return { supported: false };
  const version = binaryVersion(binary);
  const release = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!release) throw new Error('Unable to identify the installed Codex protocol version.');
  if (Number(release[1]) === 0 && Number(release[2]) < 154) return { supported: false };
  const key = `${binary}:${version}`;
  if (cache.has(key)) return cache.get(key);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-codex-protocol-'));
  let supported = false;
  try {
    runExecutable(binary, ['app-server', 'generate-ts', '--out', directory], {
      stdio: 'pipe', timeout: 20_000,
    });
    const methods = ['Thread', 'ThreadStatus', 'ThreadListParams', 'ThreadReadParams', 'ThreadArchiveParams', 'ThreadUnarchiveParams'];
    supported = methods.every((name) => fs.existsSync(path.join(directory, 'v2', `${name}.ts`)))
      && ['archived?', 'sourceKinds?', 'modelProviders?'].every((field) => (
        fs.readFileSync(path.join(directory, 'v2/ThreadListParams.ts'), 'utf8').includes(field)
      ))
      && ['parentThreadId:', 'status:', 'path:'].every((field) => (
        fs.readFileSync(path.join(directory, 'v2/Thread.ts'), 'utf8').includes(field)
      ));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const result = { supported };
  cache.set(key, result);
  return result;
}
