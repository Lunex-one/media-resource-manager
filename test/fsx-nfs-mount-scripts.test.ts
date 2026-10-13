// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The scripts `lambda/fsx-nfs-mount-manager` sends to a workstation, built from a mount path and a
 * storage name written to break out of a script.
 *
 * Until these scripts went through `script-quote.js`, a workstation's `storageConfig` mount path
 * and a storage record's name were pasted between double quotes, into an unquoted heredoc, into a
 * `sed` program and into a launchd plist, so `$(...)` in either ran as root, on macOS at every
 * boot. The bash scripts are checked by running bash over their assignments and over the macOS
 * launcher; the systemd unit and the plist by what they contain.
 *
 * Hermetic: `scripts.js` imports nothing but the quoting helper.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const scripts = require('../lambda/fsx-nfs-mount-manager/scripts.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const q = require('../lambda/fsx-nfs-mount-manager/script-quote.js');

const CANARY = '/tmp/mrm-fsx-nfs-scripts-canary';
const RUN = `$(touch ${CANARY})`;

const storage = {
  storageId: '5f0c2a9e-0000-4000-8000-000000000000',
  type: 'fsx-ontap',
  name: `../../Library/LaunchDaemons/x ${RUN} \`touch ${CANARY}\` it's "quoted" <tag>&`,
};
const nfsEndpoint = 'svm-0123.fs-0abc.fsx.eu-central-1.amazonaws.com';
const junctionPath = '/vol1';
const mountPath = `/mnt/media ${RUN} "x" 'y' <z>&`;
const serviceName = scripts.serviceNameFor(storage.storageId);

/** The block of assignments a generated bash script opens with: from the first to a blank line. */
function assignments(script: string): string {
  const lines = script.split('\n');
  const first = lines.findIndex((line) => /^[A-Z_]+=/.test(line));
  const end = lines.findIndex((line, i) => i > first && line.trim() === '');
  return lines.slice(first, end).join('\n');
}

/** Runs bash over `body`, then prints the named variables one per line. */
function bashValues(body: string, names: string[]): string[] {
  const printer = names.map((name) => `printf '%s\\n' "$${name}"`).join('\n');
  const out = execFileSync('bash', ['-c', `${body}\n${printer}`], { encoding: 'utf8' });
  return out.split('\n').slice(0, names.length);
}

/** The text a generated script writes through the heredoc with the given delimiter. */
function heredoc(script: string, delimiter: string): string {
  const start = script.indexOf(`<< '${delimiter}'\n`);
  expect(start).toBeGreaterThan(-1);
  const body = script.slice(script.indexOf('\n', start) + 1);
  return body.slice(0, body.indexOf(`\n${delimiter}\n`));
}

function isValidBash(script: string): void {
  expect(() => execFileSync('bash', ['-n'], { input: script })).not.toThrow();
}

beforeEach(() => fs.rmSync(CANARY, { force: true }));
afterAll(() => fs.rmSync(CANARY, { force: true }));

describe('the Linux mount script', () => {
  const linuxPath = `/mnt/media ${RUN} "x" 'y'`;
  const script = scripts.generateLinuxNfsMountScript(storage, nfsEndpoint, junctionPath, linuxPath, serviceName);

  it('is valid bash', () => isValidBash(script));

  it('assigns every value exactly as given, and runs nothing', () => {
    const values = bashValues(assignments(script), ['NFS_ENDPOINT', 'JUNCTION_PATH', 'MOUNT_PATH']);
    expect(values).toEqual([nfsEndpoint, junctionPath, linuxPath]);
    expect(fs.existsSync(CANARY)).toBe(false);
  });

  it('writes the unit with a quoted heredoc, holding the storage name nowhere', () => {
    const unit = heredoc(script, 'MRM_UNIT_EOF');
    expect(unit).not.toContain(storage.name);
    expect(unit).toContain(`Description=FSxN NFS Mount - ${serviceName}`);
    expect(unit).toContain(`What=${nfsEndpoint}:${junctionPath}`);
    expect(unit).toContain(`Where=${linuxPath}`);
    expect(script).not.toMatch(/<< EOF/);
  });

  it('takes the unit name from systemd-escape on the host, after `--`', () => {
    expect(script).toContain('UNIT_NAME=$(systemd-escape --path -- "$MOUNT_PATH")');
  });

  it.each([
    ['a % specifier', '/mnt/100%'],
    ['a backslash', '/mnt/line\\'],
  ])('refuses a mount path holding %s, which a unit file reads as syntax', (_what, path) => {
    expect(() =>
      scripts.generateLinuxNfsMountScript(storage, nfsEndpoint, junctionPath, path, serviceName),
    ).toThrow(q.UnsafeValueError);
  });
});

describe('the macOS mount script', () => {
  const script = scripts.generateMacOsNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName);

  it('is valid bash', () => isValidBash(script));

  it('assigns every value exactly as given, and runs nothing', () => {
    const values = bashValues(assignments(script), ['NFS_ENDPOINT', 'JUNCTION_PATH', 'MOUNT_PATH']);
    expect(values).toEqual([nfsEndpoint, junctionPath, mountPath]);
    expect(fs.existsSync(CANARY)).toBe(false);
  });

  it('no longer edits the launcher with sed', () => {
    expect(script).not.toMatch(/\bsed\b/);
  });

  it('writes a launcher whose values are literals and whose label is a file name', () => {
    const launcher = heredoc(script, 'MRM_SCRIPT_EOF');
    isValidBash(launcher);
    const [path, endpoint, junction, label] = bashValues(assignments(launcher), [
      'MOUNT_PATH',
      'NFS_ENDPOINT',
      'JUNCTION_PATH',
      'VOLUME_LABEL',
    ]);
    expect([path, endpoint, junction]).toEqual([mountPath, nfsEndpoint, junctionPath]);
    expect(label).toBe(q.fileName(storage.name));
    expect(label).not.toContain('/');
    expect(fs.existsSync(CANARY)).toBe(false);
  });

  it('writes a plist with every value XML-escaped and no shell expansion', () => {
    const plist = heredoc(script, 'MRM_PLIST_EOF');
    expect(plist).toContain(`<key>${q.xml(mountPath)}</key>`);
    expect(plist).not.toContain(mountPath);
    expect(plist).not.toMatch(/<z>/);
    // Written through a quoted heredoc, so a `$` left in an escaped value is text, not expansion.
    expect(script).toContain("<< 'MRM_PLIST_EOF'");
  });
});

describe('the unmount and status scripts', () => {
  it.each([
    ['Linux unmount', scripts.generateLinuxNfsUnmountScript(mountPath, serviceName)],
    ['macOS unmount', scripts.generateMacOsNfsUnmountScript(mountPath, serviceName)],
    ['Linux status', scripts.generateLinuxStatusScript(mountPath)],
    ['macOS status', scripts.generateMacOsStatusScript(mountPath)],
  ])('%s: valid bash, the path unchanged, nothing run', (_name, script) => {
    isValidBash(script);
    const [path] = bashValues(assignments(script).replace(/^UNIT_NAME=.*$/m, ''), ['MOUNT_PATH']);
    expect(path).toBe(mountPath);
    expect(fs.existsSync(CANARY)).toBe(false);
  });

  it('quotes the path wherever it is listed', () => {
    for (const script of [
      scripts.generateLinuxNfsUnmountScript(mountPath, serviceName),
      scripts.generateMacOsNfsUnmountScript(mountPath, serviceName),
    ]) {
      expect(script).not.toMatch(/ls -A \$MOUNT_PATH/);
    }
  });

  it('reads the mount table with a fixed-string match, never a pattern from the path', () => {
    for (const script of [
      scripts.generateMacOsNfsUnmountScript(mountPath, serviceName),
      scripts.generateMacOsStatusScript(mountPath),
    ]) {
      expect(script).toContain('grep -qF -- "$MOUNT_PATH"');
      expect(script).not.toMatch(/grep -q "\$MOUNT_PATH"/);
    }
  });
});

describe('a value no script can carry', () => {
  it('is refused before any script exists', () => {
    expect(() =>
      scripts.generateMacOsNfsMountScript(storage, nfsEndpoint, junctionPath, 'two\nlines', serviceName),
    ).toThrow(q.UnsafeValueError);
    expect(() =>
      scripts.generateMacOsNfsMountScript({ ...storage, name: 'a\rb' }, nfsEndpoint, junctionPath, '/mnt/x', serviceName),
    ).toThrow(q.UnsafeValueError);
    expect(() => scripts.generateLinuxStatusScript(undefined)).toThrow('mount path is missing');
  });
});
