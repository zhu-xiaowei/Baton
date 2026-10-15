import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const verifyProductionCI = require('../../.github/scripts/verify-production-ci.cjs');
const sha = 'a'.repeat(40);
const success = () => ({
  id: 100, head_sha: sha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/100',
});
const jobs = () => [
  { name: 'Tests and frontend', conclusion: 'success' },
  ...[
    ['Android APK', 'Warm production Android build on main'],
    ['iOS archive', 'Warm production iOS build on main'],
    ['macOS DMG', 'Warm production universal macOS build on main'],
    ['Windows NSIS', 'Warm production Windows build on main'],
  ].map(([name, stepName]) => ({
    name, conclusion: 'success', steps: [{ name: stepName, conclusion: 'success' }],
  })),
];

function fixture(runs = [success()], checks = jobs()) {
  const listJobs = () => {};
  return {
    owner: 'example', repo: 'baton', sha,
    github: {
      rest: { actions: {
        listWorkflowRuns: async options => {
          assert.equal(options.event, 'push');
          assert.equal(options.branch, 'main');
          assert.equal(options.head_sha, sha);
          return { data: { workflow_runs: runs } };
        },
        listJobsForWorkflowRun: listJobs,
      } },
      paginate: async (method, options) => {
        assert.equal(method, listJobs);
        assert.equal(options.run_id, 100);
        assert.equal(options.filter, 'latest');
        return checks;
      },
    },
  };
}

test('release packaging accepts all production checks for the exact commit', async () => {
  assert.equal(await verifyProductionCI(fixture()), success().html_url);
});

test('release packaging rejects green checks from another commit or a PR', async () => {
  for (const run of [
    { ...success(), head_sha: 'b'.repeat(40) },
    { ...success(), event: 'pull_request', head_branch: 'feature' },
  ]) {
    await assert.rejects(verifyProductionCI(fixture([run])), /No production CI/);
  }
});

test('release packaging rejects failed and unfinished production CI', async () => {
  for (const run of [
    { ...success(), conclusion: 'failure' },
    { ...success(), status: 'in_progress', conclusion: null },
  ]) {
    await assert.rejects(verifyProductionCI(fixture([run])), /Production CI must pass/);
  }
});

test('an older successful run cannot hide a newer unfinished run', async () => {
  const pending = { ...success(), id: 101, status: 'queued', conclusion: null };
  await assert.rejects(verifyProductionCI(fixture([success(), pending])), /Production CI must pass/);
});

test('a skipped or missing native job cannot authorize a release', async () => {
  const skipped = jobs().map(job => job.name === 'Android APK' ? { ...job, conclusion: 'skipped' } : job);
  await assert.rejects(verifyProductionCI(fixture([success()], skipped)), /Android APK/);
  await assert.rejects(verifyProductionCI(fixture([success()], jobs().slice(0, -1))), /Windows NSIS/);
});

test('green PR-profile jobs cannot substitute for production-profile builds', async () => {
  const withoutProduction = jobs().map(job => ({ ...job, steps: [] }));
  await assert.rejects(verifyProductionCI(fixture([success()], withoutProduction)), /Android APK/);
});
