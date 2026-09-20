import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { SleepGapMonitor } from '../../bridge/sleep-gap-monitor.mjs';

const durationMs = Number(process.env.BENCH_DURATION_MS || 60_000);
const replicas = Number(process.env.BENCH_REPLICAS || 3);
const warmupMs = Number(process.env.BENCH_WARMUP_MS || 2000);
assert.ok(Number.isFinite(durationMs) && durationMs >= 1000);
assert.ok(Number.isInteger(replicas) && replicas >= 1 && replicas <= 10);
assert.ok(Number.isFinite(warmupMs) && warmupMs >= 0);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sample(intervalMs) {
  let checks = 0;
  let resumes = 0;
  const monitor = new SleepGapMonitor({
    onResume: () => { resumes += 1; },
    setInterval: (callback, configuredInterval) => {
      assert.equal(configuredInterval, 10_000);
      if (intervalMs === 0) return null;
      return setInterval(() => { checks += 1; callback(); }, intervalMs);
    },
  });
  monitor.start();
  try {
    await wait(warmupMs);
    global.gc?.();
    const memoryBefore = process.memoryUsage();
    const resourcesBefore = process.resourceUsage();
    const checksBefore = checks;
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    await wait(durationMs);
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    const resourcesAfter = process.resourceUsage();
    const memoryAfter = process.memoryUsage();
    assert.equal(resumes, 0, 'idle measurement must not detect a sleep gap');
    const cpuMs = (cpu.user + cpu.system) / 1000;
    return {
      intervalMs,
      elapsedMs,
      checks: checks - checksBefore,
      cpuMs,
      cpuPercentOfOneCore: cpuMs / elapsedMs * 100,
      rssMiB: memoryAfter.rss / 1024 ** 2,
      rssDeltaKiB: (memoryAfter.rss - memoryBefore.rss) / 1024,
      heapDeltaKiB: (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024,
      voluntaryContextSwitches: resourcesAfter.voluntaryContextSwitches - resourcesBefore.voluntaryContextSwitches,
      involuntaryContextSwitches: resourcesAfter.involuntaryContextSwitches - resourcesBefore.involuntaryContextSwitches,
    };
  } finally {
    monitor.stop();
  }
}

function microbenchmark() {
  const monitor = new SleepGapMonitor({ onResume: () => { throw new Error('unexpected gap during microbenchmark'); } });
  monitor.timer = 1;
  monitor.lastTick = Date.now();
  for (let iteration = 0; iteration < 100_000; iteration += 1) monitor.tick();
  const iterations = 1_000_000;
  const nanosecondsPerCheck = [];
  for (let round = 0; round < 5; round += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) monitor.tick();
    nanosecondsPerCheck.push((performance.now() - startedAt) * 1e6 / iterations);
  }
  return { iterationsPerRound: iterations, nanosecondsPerCheck, medianNanosecondsPerCheck: median(nanosecondsPerCheck) };
}

function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
  const micro = microbenchmark();
  const workers = new Set();
  const pending = [];
  try {
    for (const intervalMs of [0, 1000, 10_000]) {
      for (let replica = 0; replica < replicas; replica += 1) {
        pending.push(new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', String(intervalMs)], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          workers.add(child);
          let output = '';
          let errors = '';
          child.stdout.on('data', (chunk) => { output += chunk; });
          child.stderr.on('data', (chunk) => { errors += chunk; });
          child.on('error', reject);
          child.on('close', (code) => {
            workers.delete(child);
            if (code !== 0) return reject(new Error(errors || `benchmark worker exited ${code}`));
            try { resolve({ replica, ...JSON.parse(output) }); } catch (error) { reject(error); }
          });
        }));
      }
    }
    console.error(`Measuring ${replicas} isolated processes per mode for ${durationMs / 1000}s each, concurrently; no network access.`);
    const samples = await Promise.all(pending);
    const summary = [0, 1000, 10_000].map((intervalMs) => {
      const selected = samples.filter((entry) => entry.intervalMs === intervalMs);
      return {
        intervalMs,
        checksPerSample: selected.map((entry) => entry.checks),
        medianCpuMs: median(selected.map((entry) => entry.cpuMs)),
        medianCpuPercentOfOneCore: median(selected.map((entry) => entry.cpuPercentOfOneCore)),
        medianRssMiB: median(selected.map((entry) => entry.rssMiB)),
        cpuMsRange: [Math.min(...selected.map((entry) => entry.cpuMs)), Math.max(...selected.map((entry) => entry.cpuMs))],
      };
    });
    console.log(JSON.stringify({
      measuredAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model },
      durationMs,
      replicas,
      warmupMs,
      methodology: 'Independent Node processes running the production sleep monitor without sockets; warmup and initial GC excluded. Modes measured concurrently. Microbenchmark excludes timer scheduling. This is not an OS power-wakeup or battery measurement.',
      micro,
      summary,
      samples,
    }, null, 2));
  } finally {
    for (const child of workers) child.kill();
  }
}

if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await sample(Number(process.argv[3]))));
} else {
  await main();
}
