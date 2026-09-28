import { spawn } from 'child_process';

export class GitCommandError extends Error {
  constructor(errorCode, message, options = {}) {
    super(message);
    this.name = 'GitCommandError';
    this.errorCode = errorCode;
    this.stderr = options.stderr || '';
    this.stdout = options.stdout || '';
    this.exitCode = options.exitCode;
  }
}

export function operationError(errorCode, message, options) {
  return new GitCommandError(errorCode, message, options);
}

export function runGit(args, options = {}) {
  const {
    cwd,
    input,
    timeoutMs = 20_000,
    maxStdoutBytes = 10 * 1024 * 1024,
    allowedExitCodes = [0],
    env,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    let oversized = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(operationError('request_timeout', 'Git command timed out.'));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }

    child.on('error', (error) => {
      const missing = error.code === 'ENOENT';
      finish(operationError(
        missing ? 'git_unavailable' : 'git_failed',
        missing ? 'Git is not installed or not available.' : 'Unable to execute Git.',
        { stderr: error.message },
      ));
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        oversized = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('close', (exitCode) => {
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (oversized) {
        finish(operationError('git_failed', 'Git output is too large.', {
          stderr: stderrText,
          exitCode,
        }));
        return;
      }
      if (!allowedExitCodes.includes(exitCode)) {
        const notRepo = /not a git repository/i.test(stderrText);
        finish(operationError(
          notRepo ? 'not_git_repository' : 'git_failed',
          notRepo ? 'This project is not inside a Git repository.' : 'Git command failed.',
          { stderr: stderrText, stdout: Buffer.concat(stdout).toString('utf8').slice(-8192), exitCode },
        ));
        return;
      }
      finish(null, {
        stdout: Buffer.concat(stdout),
        stderr: stderrText,
        exitCode,
      });
    });

    if (input == null) child.stdin.end();
    else child.stdin.end(input);
  });
}
