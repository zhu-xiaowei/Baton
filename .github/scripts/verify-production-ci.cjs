const productionSteps = new Map([
  ['Tests and frontend', null],
  ['Android APK', 'Warm production Android build on main'],
  ['iOS archive', 'Warm production iOS build on main'],
  ['macOS DMG', 'Warm production universal macOS build on main'],
  ['Windows NSIS', 'Warm production Windows build on main'],
]);

module.exports = async function verifyProductionCI({ github, owner, repo, sha, ref }) {
  // The release branch packages candidates before they are merged into main.
  if (ref === 'refs/heads/release/testflight') return null;

  const { data } = await github.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: 'ci.yml', event: 'push', branch: 'main',
    head_sha: sha, per_page: 100,
  });
  const run = data.workflow_runs
    .filter(item => item.head_sha === sha && item.event === 'push' && item.head_branch === 'main')
    .sort((a, b) => b.id - a.id)[0];
  if (!run) throw new Error(`No production CI on main for ${sha}; merge and complete main CI before release packaging.`);
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Production CI must pass before release packaging: ${run.html_url} (${run.status}/${run.conclusion || 'pending'}).`);
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner, repo, run_id: run.id, filter: 'latest', per_page: 100,
  });
  for (const [name, stepName] of productionSteps) {
    const job = jobs.find(item => item.name === name);
    if (job?.conclusion !== 'success'
        || (stepName && !job.steps?.some(step => step.name === stepName && step.conclusion === 'success'))) {
      throw new Error(`Production validation ${name} did not pass for ${sha}: ${run.html_url}`);
    }
  }
  return run.html_url;
};
