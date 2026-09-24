import fs from 'node:fs';
import path from 'node:path';

function readGitPath(filename, relativeTo, prefix = '') {
  if (!fs.lstatSync(filename).isFile()) return null;
  const contents = fs.readFileSync(filename, 'utf8').trim();
  if (!contents.startsWith(prefix)) return null;
  const value = contents.slice(prefix.length).trim();
  if (!value || /[\r\n]/.test(value)) return null;
  return fs.realpathSync(path.resolve(relativeTo, value));
}

export function repositoryIdentity(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const canonicalCwd = fs.realpathSync(cwd);
    if (!fs.statSync(canonicalCwd).isDirectory()) return null;
    let checkoutRoot = canonicalCwd;
    let entryType;
    while (true) {
      try {
        entryType = fs.lstatSync(path.join(checkoutRoot, '.git'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') return null;
      }
      const parent = path.dirname(checkoutRoot);
      if (parent === checkoutRoot) return null;
      checkoutRoot = parent;
    }
    const gitEntry = path.join(checkoutRoot, '.git');
    let commonDir;
    if (entryType.isDirectory()) {
      commonDir = fs.realpathSync(gitEntry);
    } else if (entryType.isFile()) {
      const gitDir = readGitPath(gitEntry, checkoutRoot, 'gitdir:');
      if (!gitDir || !fs.statSync(gitDir).isDirectory()) return null;
      commonDir = readGitPath(path.join(gitDir, 'commondir'), gitDir);
      if (!commonDir || !fs.statSync(commonDir).isDirectory()) return null;
      if (path.dirname(gitDir) !== fs.realpathSync(path.join(commonDir, 'worktrees'))) return null;
      if (readGitPath(path.join(gitDir, 'gitdir'), gitDir) !== fs.realpathSync(gitEntry)) return null;
    } else {
      return null;
    }
    const primaryRoot = path.dirname(commonDir);
    const primaryGit = path.join(primaryRoot, '.git');
    if (!fs.lstatSync(primaryGit).isDirectory() || fs.realpathSync(primaryGit) !== commonDir) return null;
    return { commonDir, relativeCwd: path.relative(checkoutRoot, canonicalCwd), primaryRoot };
  } catch {
    return null;
  }
}

export function projectCwdFromCwd(cwd) {
  const identity = repositoryIdentity(cwd);
  return identity ? path.join(identity.primaryRoot, identity.relativeCwd) : cwd;
}
