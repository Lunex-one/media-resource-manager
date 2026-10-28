// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The scripts `lambda/s3-mount-manager` sends to a workstation, built from a storage record whose
 * every value was written to break out of a script.
 *
 * Until these scripts went through `script-quote.js`, a storage name or path was pasted between
 * double quotes into a bash or PowerShell script run as root or SYSTEM, so `$(...)` in a name ran
 * on every workstation the storage was mounted on. The bash scripts are checked by running bash
 * over their assignments and their launcher; the PowerShell ones by where each value ends up.
 *
 * Hermetic: `scripts.js` imports nothing but the quoting helper.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const scripts = require('../lambda/s3-mount-manager/scripts.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const q = require('../lambda/s3-mount-manager/script-quote.js');

const CANARY = '/tmp/mrm-s3-scripts-canary';
const RUN = `$(touch ${CANARY})`;

const hostile = {
  storageId: 'abc-123',
  type: 'mountpoint-s3',
  name: `../../etc/cron.d/x ${RUN} \`touch ${CANARY}\` it's "quoted" %n`,
  bucketName: `bucket${RUN}`,
  mountPath: `/mnt/media ${RUN} "x"`,
  prefix: `in/${RUN}'`,
  cachePath: `/var/cache/${RUN}`,
  accessMode: 'read-write',
  allowDelete: true,
  allowOther: true,
  uid: '1000',
  gid: 1000,
  region: 'eu-central-1',
};

const serviceName = scripts.serviceNameFor(hostile.storageId);

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

beforeEach(() => fs.rmSync(CANARY, { force: true }));
afterAll(() => fs.rmSync(CANARY, { force: true }));

describe('the Linux mount script', () => {
  const script = scripts.generateMountScript(hostile, serviceName);

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n'], { input: script })).not.toThrow();
  });

  it('assigns every value exactly as the record holds it, and runs nothing', () => {
    const values = bashValues(assignments(script), ['BUCKET_NAME', 'MOUNT_PATH', 'CACHE_PATH']);
    expect(values).toEqual([hostile.bucketName, hostile.mountPath, hostile.cachePath]);
    expect(fs.existsSync(CANARY)).toBe(false);
  });

  it('names the desktop file without a path separator', () => {
    const [fileName] = bashValues(assignments(script), ['DESKTOP_FILE_NAME']);
    expect(fileName).not.toContain('/');
    expect(fileName.endsWith('.desktop')).toBe(true);
  });

  it('writes no record value into the systemd unit', () => {
    const unit = script.slice(script.indexOf("<< 'MRM_UNIT_EOF'"), script.lastIndexOf('MRM_UNIT_EOF'));
    for (const value of [hostile.name, hostile.bucketName, hostile.mountPath, hostile.prefix, hostile.cachePath]) {
      expect(unit).not.toContain(value);
    }
    expect(unit).not.toContain('%');
  });

  it('writes the launcher and the unit with quoted heredocs, which expand nothing', () => {
    expect(script).toContain("<< 'MRM_LAUNCHER_EOF'");
    expect(script).toContain("<< 'MRM_UNIT_EOF'");
    expect(script).not.toMatch(/<< EOF/);
  });
});

describe('the launcher systemd runs', () => {
  const launcher = scripts.linuxLauncher(hostile);

  it('hands mount-s3 the bucket, the path and each option as separate, unchanged words', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-launcher-'));
    try {
      // A stand-in for mount-s3 that prints the words it was given, one per line.
      const fake = path.join(dir, 'mount-s3');
      fs.writeFileSync(fake, '#!/bin/bash\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
      const body = launcher.replace('/usr/bin/mount-s3', fake);
      const out = execFileSync('bash', ['-c', body, 'launcher', 'start'], { encoding: 'utf8' });
      expect(out.split('\n').slice(0, -1)).toEqual([
        hostile.bucketName,
        hostile.mountPath,
        '--prefix',
        hostile.prefix,
        '--allow-delete',
        '--allow-other',
        '--uid',
        '1000',
        '--gid',
        '1000',
        '--cache',
        hostile.cachePath,
      ]);
      expect(fs.existsSync(CANARY)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a uid that is not a number', () => {
    expect(() => scripts.linuxLauncher({ ...hostile, uid: '0; reboot' })).toThrow('uid is not a whole number');
  });
});

describe('the Linux unmount and status scripts', () => {
  it.each([
    ['unmount', scripts.generateUnmountScript(hostile, serviceName), ['MOUNT_PATH', 'DESKTOP_FILE_NAME']],
    ['status', scripts.generateStatusScript(hostile, serviceName), ['MOUNT_PATH']],
  ])('%s: valid bash, values unchanged, nothing run', (_name, script, names) => {
    expect(() => execFileSync('bash', ['-n'], { input: script as string })).not.toThrow();
    const values = bashValues(assignments(script as string), names as string[]);
    expect(values[0]).toBe(hostile.mountPath);
    if ((names as string[]).includes('DESKTOP_FILE_NAME')) {
      expect(values[1]).not.toContain('/');
    }
    expect(fs.existsSync(CANARY)).toBe(false);
  });
});

describe('the Windows scripts', () => {
  const windows = { ...hostile, mountPath: 'Y:', name: `Media $(Get-Process) '‘` };
  const mount = scripts.generateWindowsMountScript(windows, serviceName);

  it('assigns every record value as a single-quoted literal', () => {
    for (const [variable, value] of [
      ['$BucketName', windows.bucketName],
      ['$MountPath', windows.mountPath],
      ['$CachePath', windows.cachePath],
    ]) {
      expect(mount).toContain(`${variable} = ${q.ps(value)}`);
    }
  });

  it('mentions a record value only on the lines that assign it as a literal', () => {
    const literal = /^\$[A-Za-z]+ = '/;
    const elsewhere = mount.split('\n').filter((line: string) => !literal.test(line));
    for (const value of [windows.name, windows.bucketName, windows.prefix, windows.cachePath]) {
      for (const line of elsewhere) {
        expect(line).not.toContain(value);
      }
    }
  });

  it('quotes every rclone argument by the Windows rules', () => {
    const commandLine = scripts.windowsRcloneCommandLine(windows, 'eu-central-1');
    expect(commandLine).toContain(q.winArg(windows.name));
    expect(commandLine).toContain(q.winArg(windows.mountPath));
    expect(commandLine.startsWith('"C:\\ProgramData\\rclone\\rclone.exe" "mount" ')).toBe(true);
  });

  it('uses a file-safe name for the shortcuts', () => {
    expect(mount).toContain(`$SafeStorageName = ${q.ps(q.fileName(windows.name))}`);
  });

  it.each([
    ['unmount', scripts.generateWindowsUnmountScript(windows, serviceName)],
    ['status', scripts.generateWindowsStatusScript(windows, serviceName)],
  ])('%s assigns the mount path as a literal', (_name, script) => {
    expect(script).toContain(`$MountPath = ${q.ps(windows.mountPath)}`);
  });
});

describe('a value no script can carry', () => {
  it('is refused before any script exists', () => {
    expect(() => scripts.generateMountScript({ ...hostile, name: 'two\nlines' }, serviceName)).toThrow(
      q.UnsafeValueError,
    );
    expect(() => scripts.generateWindowsMountScript({ ...hostile, bucketName: undefined }, serviceName)).toThrow(
      'bucket name is missing',
    );
  });
});
