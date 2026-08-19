/**
 * Host-binding configuration tests.
 *
 * The server must bind 0.0.0.0 by default: Render (and other platform
 * containers) probe the container's external interface, and a loopback bind
 * makes the port invisible ("no open ports detected on 0.0.0.0"). Each test
 * runs in a fresh child process so the module-level env snapshot in
 * config.js is taken with a clean environment.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';

function loadConfigInCleanProcess(envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.HOST;
    Object.assign(env, envOverrides);
    execFile(
      process.execPath,
      ['--input-type=module', '-e', "import('./src/config.js').then((m) => console.log(JSON.stringify({ host: m.HOST })))"],
      { cwd: process.cwd(), env },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(JSON.parse(stdout.trim()));
      },
    );
  });
}

test('config: HOST defaults to 0.0.0.0 (Render-compatible bind)', async () => {
  const { host } = await loadConfigInCleanProcess();
  assert.equal(host, '0.0.0.0');
});

test('config: HOST env override still wins when set explicitly', async () => {
  const { host } = await loadConfigInCleanProcess({ HOST: '127.0.0.1' });
  assert.equal(host, '127.0.0.1');
});