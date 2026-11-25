// The App's star prompt: this computer's signed-in gh checks or adds the star on github.com.
import { execFile } from 'node:child_process';

const gh = (args) => new Promise((resolve) => execFile('gh', args, { timeout: 5000, windowsHide: true }, (error) => resolve(!error)));

export async function githubStar({ star = false } = {}) {
  if (!await gh(['auth', 'status', '--hostname', 'github.com'])) return { gh: false };
  const repo = 'user/starred/agentbaton/baton';
  return { gh: true, starred: await gh(star ? ['api', '-X', 'PUT', repo] : ['api', repo]) };
}
