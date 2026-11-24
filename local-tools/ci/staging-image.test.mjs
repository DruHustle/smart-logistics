import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL(
  '../../smart-logistics-backend/server/system/production-boot-check.sh', import.meta.url,
));
const image = 'ghcr.io/druhustle/imsop-backend@sha256:' + 'b'.repeat(64);
const revision = 'a'.repeat(40);
const source = 'https://github.com/DruHustle/smart-logistics';
const approved = `linux/arm64 ${revision} ${source}`;
const inspection = ['image', 'network', 'network', 'volume', 'volume', 'compose'];

async function run(args, metadata, outcome = 'existing') {
  const root = await mkdtemp(join(tmpdir(), 'logistics-stage-guard-'));
  const stub = join(root, 'docker');
  const log = join(root, 'calls');
  const rendered = join(root, 'compose.json');
  const project = join(root, 'project');
  try {
    await writeFile(stub, [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$1" >> "$STAGE_CALLS"',
      'case "$1" in',
      '  image) printf "%s\\n" "$STAGE_METADATA" ;;',
      '  network|volume)',
      '    [[ "$2" == ls ]] || exit 91',
      '    if [[ "$STAGE_OUTCOME" == "$1" ]]; then printf "%s\\n" occupied; fi ;;',
      '  compose)',
      '    [[ "$6" == ps && "$STAGE_OUTCOME" != unreadable ]] || exit 91',
      '    printf "%s\\n" "$3" > "$STAGE_PROJECT"',
      '    cp "$5" "$STAGE_RENDERED"',
      '    if [[ "$STAGE_OUTCOME" == existing ]]; then printf "%s\\n" occupied; fi ;;',
      '  *) exit 92 ;;',
      'esac',
    ].join('\n'));
    await chmod(stub, 0o700);
    await writeFile(log, '');
    const run = spawnSync('bash', [script, '--stage-image', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        STAGE_METADATA: metadata,
        STAGE_CALLS: log,
        STAGE_OUTCOME: outcome,
        STAGE_PROJECT: project,
        STAGE_RENDERED: rendered,
      },
    });
    const files = await Promise.all([project, rendered].map(path => readFile(path, 'utf8').catch(() => '')));
    return {
      status: run.status, stderr: run.stderr, calls: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean),
      project: files[0].trim(), compose: files[1] && JSON.parse(files[1]),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('staging bootstrap refuses mutable or unapproved images and incomplete revisions before Docker', async () => {
  for (const args of [
    ['ghcr.io/druhustle/imsop-backend:latest', revision],
    [image.replace('imsop-backend', 'imsop-gateway'), revision],
    [image, 'abcd1234'],
  ]) {
    const result = await run(args, '');
    assert.deepEqual(result.calls, []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /immutable published Logistics image/);
  }
});

test('only the expected ARM64 image can reach the existing isolated stack check', async () => {
  for (const metadata of [
    `linux/amd64 ${revision} ${source}`,
    `linux/arm64 ${'c'.repeat(40)} ${source}`,
    `linux/arm64 ${revision} https://example.com/unqualified`,
  ]) {
    const result = await run([image, revision], metadata);
    assert.deepEqual(result.calls, ['image']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /differs from the expected ARM64 source/);
  }
  const result = await run([image, revision], approved);
  assert.deepEqual(result.calls, inspection);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to reuse an existing production-check stack/);
});

test('an unreadable Compose project stops before launch or cleanup', async () => {
  const result = await run([image, revision], approved, 'unreadable');
  assert.deepEqual(result.calls, inspection);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unable to verify the disposable production-check stack is unused/);
});

test('an existing stage network or data volume stops before Compose', async () => {
  for (const [resource, calls] of [
    ['network', ['image', 'network', 'network']],
    ['volume', ['image', 'network', 'network', 'volume', 'volume']],
  ]) {
    const result = await run([image, revision], approved, resource);
    assert.deepEqual(result.calls, calls);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /disposable network and volume are unused/);
  }
});

test('each stage render has a new project, capped containers and a single internal network', async () => {
  const a = await run([image, revision], approved);
  const b = await run([image, revision], approved);
  assert.match(a.project, /^imsop-stage-[a-f0-9]{24}$/);
  assert.match(b.project, /^imsop-stage-[a-f0-9]{24}$/);
  assert.notEqual(a.project, b.project);
  const { backend, database } = a.compose.services;
  assert.deepEqual(a.compose.networks, { sandbox: { internal: true } });
  assert.deepEqual(a.compose.volumes, { data: {} });
  assert.equal(backend.image, image);
  assert.deepEqual(backend.ports, ['127.0.0.1:18069:10000']);
  assert.equal(database.ports, undefined);
  assert.deepEqual(database.volumes, ['data:/var/lib/postgresql/data']);
  for (const [container, cpu, memory] of [[backend, '0.50', '1024m'], [database, '0.25', '256m']]) {
    assert.deepEqual(container.networks, ['sandbox']);
    assert.equal(container.cpus, cpu);
    assert.equal(container.mem_limit, memory);
    assert.equal(container.memswap_limit, memory);
    assert.equal(container.pull_policy, 'never');
  }
});

async function disposableServer(testContext, handle) {
  const server = createServer(handle);
  try {
    await once(server.listen(18069, '127.0.0.1'), 'listening');
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    testContext.skip('The disposable loopback port is already in use');
    return null;
  }
  testContext.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

test('an occupied disposable loopback port prevents launch and cleanup', async t => {
  if (!await disposableServer(t, (_request, res) => res.end())) return;
  const result = await run([image, revision], approved, 'empty');
  assert.deepEqual(result.calls, inspection);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /disposable staging loopback port is unavailable/);
});

test('the host Python probe verifies the exact revision and anonymous origin policy without Node', async t => {
  if (!await disposableServer(t, (req, res) => {
    if (req.url === '/ready') return res.end('ready');
    if (req.url === '/version') return res.end(JSON.stringify({ revision, apiContract: 2 }));
    res.statusCode = 401;
    if (req.headers.origin === 'https://imsop.test') {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    res.end();
  })) return;

  const lines = (await readFile(script, 'utf8')).split('\n');
  const marker = lines.findIndex(line => line.includes('python3 - "$stage_revision"'));
  const end = lines.indexOf('PY', marker + 1);
  assert(marker >= 0 && end > marker);
  const probe = lines.slice(marker + 1, end).join('\n');
  async function validate(expected) {
    const child = spawn('python3', ['-', expected], { stdio: 'pipe', timeout: 6000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.end(probe);
    const [status] = await once(child, 'close');
    return { status, stdout, stderr };
  }
  const good = await validate(revision);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).revision, revision);
  const wrong = await validate('c'.repeat(40));
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stdout, '');
  assert.match(wrong.stderr, /source or contract differs/);
});
