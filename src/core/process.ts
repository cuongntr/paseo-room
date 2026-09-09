import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { ProcessRunner } from './seams.js';

/** No inherited environment, shell expansion, unbounded output, or raw spawn errors. */
export const processRunner: ProcessRunner = {
  run(input) {
    if (!isAbsolute(input.executable) ||
        !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) {
      return Promise.reject(new Error('Use an absolute executable and a timeout between 1 and 30000 ms.'));
    }
    return new Promise((resolve, reject) => {
      execFile(input.executable, [...input.args], {
        env: { ...input.env }, shell: false, timeout: input.timeoutMs,
        killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          const failure = new Error('Process probe could not complete; check executable availability and timeout.');
          // Preserve only safe retry classification, never raw process error text/output.
          const code = error.killed ? 'ETIMEDOUT' : error.code;
          reject(['EAGAIN', 'EINTR', 'ETIMEDOUT'].includes(String(code)) ? Object.assign(failure, { code }) : failure);
          return;
        }
        resolve({ exitCode: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
      });
    });
  },
};
