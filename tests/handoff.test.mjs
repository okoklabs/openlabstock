import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createHandoff, inspectHandoff, restoreHandoff } from '../scripts/handoff.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

test('handoff captures complete history, dirty changes and restores safely', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-handoff-test-'));
  const repository = path.join(workspace, 'repo');
  const output = path.join(workspace, 'handoff.tar.gz');
  const restored = path.join(workspace, 'restored');
  try {
    await mkdir(repository, { recursive: true });
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.email', 'handoff-test@example.invalid']);
    git(repository, ['config', 'user.name', 'Handoff Test']);
    await writeFile(path.join(repository, '.gitignore'), 'data/\n.openlabstock-*.json\n');
    await writeFile(path.join(repository, 'package.json'), '{"name":"handoff-fixture","version":"1.0.0"}\n');
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'initial']);
    const originalHead = git(repository, ['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(repository, 'package.json'), '{"name":"handoff-fixture","version":"1.1.0"}\n');
    git(repository, ['add', 'package.json']);
    await writeFile(path.join(repository, 'README.md'), 'changed but not committed\n');
    await writeFile(path.join(repository, 'notes.txt'), 'remember this\n');
    await writeFile(path.join(repository, '.openlabstock-verification.json'), '{"verified":true}\n');
    await mkdir(path.join(repository, 'data'), { recursive: true });
    await writeFile(path.join(repository, 'data', 'should-not-travel.txt'), 'private\n');

    const created = await createHandoff({ root: repository, output });
    assert.equal(created.metadata.sourceHead, originalHead);
    assert.equal(created.metadata.dirty, true);
    assert.deepEqual(created.metadata.untrackedFiles, ['notes.txt']);
    assert.equal((await readFile(`${output}.sha256`, 'utf8')).includes(created.archiveHash), true);
    assert.match(created.metadata.runtime.node, /^v\d+/);
    await assert.rejects(
      createHandoff({ root: repository, output: path.join(repository, 'inside.tar.gz') }),
      /Handoff output must be outside the repository/,
    );

    const inspected = await inspectHandoff(output);
    assert.equal(inspected.metadata.sourceHead, originalHead);
    assert.equal(inspected.outerChecksumVerified, true);
    assert.ok(inspected.entries.includes('git/openlabstock.bundle'));
    assert.ok(inspected.entries.includes('git/source.tar.gz'));
    assert.ok(inspected.entries.includes('worktree/changes.patch'));
    assert.ok(inspected.entries.includes('worktree/index.patch'));
    assert.ok(inspected.entries.includes('worktree/worktree.patch'));
    assert.ok(inspected.entries.includes('README-FIRST.md'));
    assert.ok(inspected.entries.includes('tools/handoff.mjs'));

    const restoredResult = await restoreHandoff({ archivePath: output, target: restored });
    assert.equal(restoredResult.metadata.sourceHead, originalHead);
    assert.equal((await readFile(path.join(restored, 'README.md'), 'utf8')).replaceAll('\r\n', '\n'), 'changed but not committed\n');
    assert.equal((await readFile(path.join(restored, 'notes.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'remember this\n');
    assert.equal((await readFile(path.join(restored, 'package.json'), 'utf8')).replaceAll('\r\n', '\n'), '{"name":"handoff-fixture","version":"1.1.0"}\n');
    assert.equal(await readFile(path.join(restored, '.handoff', 'HANDOFF.md'), 'utf8').then((value) => value.includes('OpenLabStock Handoff')), true);
    assert.equal(await readFile(path.join(restored, '.handoff', 'verification', '.openlabstock-verification.json'), 'utf8'), '{"verified":true}\n');
    assert.equal(await readFile(path.join(restored, 'data', 'should-not-travel.txt')).then(() => true, () => false), false);
    assert.equal(git(restored, ['rev-parse', 'HEAD']).trim(), originalHead);
    assert.match(git(restored, ['status', '--short']), /README\.md/);
    assert.match(git(restored, ['status', '--short']), /notes\.txt/);
    assert.match(git(restored, ['status', '--short']), /M  package\.json/);
    assert.equal(git(restored, ['for-each-ref', '--format=%(refname)', 'refs/openlabstock-handoff/']).trim(), '');

    const occupiedTarget = path.join(workspace, 'occupied');
    await mkdir(occupiedTarget);
    await writeFile(path.join(occupiedTarget, 'keep.txt'), 'keep\n');
    await assert.rejects(
      restoreHandoff({ archivePath: output, target: occupiedTarget }),
      /Restore target must be new or empty/,
    );
    assert.equal(await readFile(path.join(occupiedTarget, 'keep.txt'), 'utf8'), 'keep\n');

    const emptyTarget = path.join(workspace, 'empty');
    await mkdir(emptyTarget);
    await assert.rejects(
      restoreHandoff({ archivePath: path.join(workspace, 'missing.tar.gz'), target: emptyTarget }),
      /Handoff archive not found/,
    );
    assert.deepEqual(await readdir(emptyTarget), []);

    await writeFile(`${output}.sha256`, `${'0'.repeat(64)}  handoff.tar.gz\n`);
    await assert.rejects(inspectHandoff(output), /Handoff archive SHA-256 mismatch/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
