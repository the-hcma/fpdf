// integration: runs .github/ci/pnpm under bash with stub pnpm and with-tmp-layout executables.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../.github/ci/pnpm');

describe('.github/ci/pnpm wrapper', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ci-pnpm-wrapper-'));
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(
      path.join(root, 'bin', 'pnpm'),
      '#!/usr/bin/env bash\nprintf "pnpm %s\\n" "$*" >> "$STUB_LOG"\n',
    );
    chmodSync(path.join(root, 'bin', 'pnpm'), 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(env: Record<string, string>): {
    status: number | null;
    stderr: string;
    log: string;
  } {
    const result = spawnSync('bash', [script, 'run', 'check'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${path.join(root, 'bin')}:/usr/bin:/bin:${process.env.PATH ?? ''}`,
        HOME: path.join(root, 'home'),
        STUB_LOG: path.join(root, 'log'),
        ...env,
      },
    });
    let log = '';
    try {
      log = readFileSync(path.join(root, 'log'), 'utf8');
    } catch {
      // The stub never ran.
    }
    return { status: result.status, stderr: result.stderr, log };
  }

  function fakeHelpers(): string {
    const helpers = path.join(root, 'helpers');
    mkdirSync(path.join(helpers, 'scripts', 'dev'), { recursive: true });
    const fake = path.join(helpers, 'scripts', 'dev', 'with-tmp-layout');
    writeFileSync(
      fake,
      '#!/usr/bin/env bash\nprintf "layout %s\\n" "$1" >> "$STUB_LOG"\nshift 2\nexec "$@"\n',
    );
    chmodSync(fake, 0o755);
    return helpers;
  }

  it('runs pnpm unchanged on a host without the layout helper', () => {
    const result = run({ REPOSITORY_HELPERS_DIR: path.join(root, 'none') });
    expect(result.status).toBe(0);
    expect(result.log).toBe('pnpm run check\n');
  });

  it('fails in GitHub Actions with a pointer to the setup-tmp-layout action when the helper is missing', () => {
    const result = run({ GITHUB_ACTIONS: 'true', REPOSITORY_HELPERS_DIR: path.join(root, 'none') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('setup-tmp-layout');
    expect(result.log).toBe('');
  });

  it('runs pnpm inside the pnpm layout when the helper exists', () => {
    const result = run({ REPOSITORY_HELPERS_DIR: fakeHelpers() });
    expect(result.status).toBe(0);
    expect(result.log).toBe('layout pnpm\npnpm run check\n');
  });

  it('does not re-enter the layout when CI_TMP_LAYOUT is already set', () => {
    const result = run({ CI_TMP_LAYOUT: '1', REPOSITORY_HELPERS_DIR: fakeHelpers() });
    expect(result.status).toBe(0);
    expect(result.log).toBe('pnpm run check\n');
  });
});

describe('release-please publish step', () => {
  it('runs pnpm publish through with-tmp-layout and keeps the provenance flag', () => {
    const workflow = readFileSync(
      path.resolve(__dirname, '../../.github/workflows/release-please.yml'),
      'utf8',
    );
    const step = /^ {6}- name: Publish to npm\n {8}run: \|\n {10}(.+)$/m.exec(workflow);
    expect(step?.[1]).toBe(
      '"$REPOSITORY_HELPERS_DIR/scripts/dev/with-tmp-layout" pnpm -- pnpm publish --ignore-scripts --no-git-checks --access public --provenance',
    );
  });
});
