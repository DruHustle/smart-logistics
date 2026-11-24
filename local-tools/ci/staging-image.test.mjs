import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function run(args, metadata, refuseInspection = false) {
  const root = await mkdtemp(join(tmpdir(), 'logistics-stage-guard-'));
  const stub = join(root, 'docker');
  const log = join(root, 'calls');
  try {
    await writeFile(stub, [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$1" >> "$STAGE_CALLS"',
      'case "$1" in',
      '  image) printf "%s\\n" "$STAGE_METADATA" ;;',
      '  compose) [[ "$6" == ps && "$STAGE_REFUSE_INSPECTION" == false ]] || exit 91; printf "%s\\n" existing-isolated-fixture ;;',
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
        STAGE_REFUSE_INSPECTION: String(refuseInspection),
      },
    });
    return { status: run.status, stderr: run.stderr, calls: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) };
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
  const result = await run([image, revision], `linux/arm64 ${revision} ${source}`);
  assert.deepEqual(result.calls, ['image', 'compose']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to reuse an existing production-check stack/);
});

test('an unreadable Compose project stops before launch or cleanup', async () => {
  const result = await run([image, revision], `linux/arm64 ${revision} ${source}`, true);
  assert.deepEqual(result.calls, ['image', 'compose']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unable to verify the disposable production-check stack is unused/);
});
