// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `script-quote.js`, the quoting every Lambda uses for a value it pastes into a
 * script that runs on a workstation as root or SYSTEM.
 *
 * The bash quoting is checked by running bash: a value goes in, `printf` prints what bash made of
 * it, and the two must be equal. A value that bash would have expanded or executed would differ.
 * PowerShell is not installed where these tests run, so its quoting is checked against the
 * language rules instead.
 *
 * The helper is copied byte-identical into each Lambda that builds a script; the last test holds
 * that every copy is the same file, so exercising one copy exercises all of them.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// `require` and not `import`, because the subject is a CommonJS lambda file and this project's
// tsconfig has no `allowJs`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const q = require('../lambda/s3-mount-manager/script-quote.js');

/** Values written to break out of a quoted string, in bash, PowerShell or both. */
const HOSTILE = [
  'plain',
  'with space',
  `it's`,
  'double " quote',
  'dollar $HOME',
  'subshell $(touch /tmp/mrm-script-quote-canary)',
  'backtick `touch /tmp/mrm-script-quote-canary`',
  'semicolon; touch /tmp/mrm-script-quote-canary',
  'glob *',
  'back\\slash',
  'trailing backslash\\',
  `quote at end'`,
  '‘typographic’ quotes',
  '%s %n percent',
  '-n',
  '',
];

const CANARY = '/tmp/mrm-script-quote-canary';

/** What bash makes of a word: printed back exactly, with nothing appended. */
function bashEcho(word: string): string {
  return execFileSync('bash', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' });
}

describe('sh', () => {
  beforeEach(() => fs.rmSync(CANARY, { force: true }));

  it.each(HOSTILE)('reaches bash unchanged: %j', (value) => {
    expect(bashEcho(q.sh(value))).toBe(value);
  });

  it('executes nothing', () => {
    for (const value of HOSTILE) {
      bashEcho(q.sh(value));
    }
    expect(fs.existsSync(CANARY)).toBe(false);
  });

  it('survives being assigned and expanded, as the scripts use it', () => {
    for (const value of HOSTILE) {
      const out = execFileSync('bash', ['-c', `V=${q.sh(value)}; printf '%s' "$V"`], { encoding: 'utf8' });
      expect(out).toBe(value);
    }
  });
});

describe('plain', () => {
  it.each(['line\nbreak', 'carriage\rreturn', 'nul\u0000byte', 'tab\there', 'escape\u001b[31m', 'del\u007f'])(
    'refuses a control character: %j',
    (value) => {
      expect(() => q.plain(value, 'storage name')).toThrow(q.UnsafeValueError);
      expect(() => q.sh(value)).toThrow(q.UnsafeValueError);
      expect(() => q.ps(value)).toThrow(q.UnsafeValueError);
    },
  );

  it('refuses a missing value instead of pasting "undefined"', () => {
    expect(() => q.sh(undefined, 'mount path')).toThrow('mount path is missing');
    expect(() => q.ps(null, 'bucket name')).toThrow('bucket name is missing');
  });

  it('names the value it refused', () => {
    expect(() => q.plain('a\nb', 'storage name')).toThrow('storage name contains a control character');
  });
});

describe('ps', () => {
  it('is a single-quoted literal, in which PowerShell expands nothing', () => {
    expect(q.ps('dollar $(Get-Process) and "double"')).toBe(`'dollar $(Get-Process) and "double"'`);
  });

  it('writes a quote twice', () => {
    expect(q.ps(`it's`)).toBe(`'it''s'`);
  });

  it('doubles the typographic quotes PowerShell also closes a string with', () => {
    expect(q.ps('a\u2018b\u2019c\u201ad\u201be')).toBe("'a\u2018\u2018b\u2019\u2019c\u201a\u201ad\u201b\u201be'");
  });

  it('leaves no quote character undoubled inside the literal', () => {
    for (const value of HOSTILE) {
      const inner = q.ps(value).slice(1, -1);
      // Remove every doubled quote pair; what is left must hold no quote at all.
      const left = inner.replace(/(['\u2018\u2019\u201a\u201b])\1/g, '');
      expect(left).not.toMatch(/['\u2018\u2019\u201a\u201b]/);
    }
  });
});

describe('winArg', () => {
  // The examples from Microsoft's "Parsing C++ command-line arguments", run backwards.
  it.each([
    ['a b c', '"a b c"'],
    ['ab"c', '"ab\\"c"'],
    ['\\\\', '"\\\\\\\\"'],
    ['a\\\\\\b', '"a\\\\\\b"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['C:\\dir\\', '"C:\\dir\\\\"'],
    ['Y:', '"Y:"'],
  ])('quotes %j as %s', (value, expected) => {
    expect(q.winArg(value)).toBe(expected);
  });
});

describe('fileName', () => {
  it.each([
    ['../../etc/cron.d/x', '_.._etc_cron.d_x'],
    ['/etc/passwd', '_etc_passwd'],
    ['..', 'storage'],
    ['.hidden', 'hidden'],
    ['a:b*c?d"e<f>g|h\\i', 'a_b_c_d_e_f_g_h_i'],
    ['Project Media', 'Project Media'],
  ])('makes %j a name inside its directory: %j', (value, expected) => {
    expect(q.fileName(value)).toBe(expected);
  });

  it('never yields a path separator or a leading dot', () => {
    for (const value of HOSTILE) {
      const name = q.fileName(value);
      expect(name).not.toMatch(/[\\/]/);
      expect(name.startsWith('.')).toBe(false);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('desktop file values', () => {
  it('escapes a backslash in a string value', () => {
    expect(q.desktopString('a\\b')).toBe('a\\\\b');
  });

  it('quotes an Exec argument by the specification, string escape applied last', () => {
    expect(q.desktopExecArg('/mnt/my bucket')).toBe('"/mnt/my bucket"');
    expect(q.desktopExecArg('/mnt/$x')).toBe('"/mnt/\\\\$x"');
    expect(q.desktopExecArg('/mnt/a"b')).toBe('"/mnt/a\\\\"b"');
    expect(q.desktopExecArg('/mnt/a`b')).toBe('"/mnt/a\\\\`b"');
    expect(q.desktopExecArg('/mnt/a\\b')).toBe('"/mnt/a\\\\\\\\b"');
  });
});

describe('integer', () => {
  it('passes digits', () => {
    expect(q.integer(1000, 'uid')).toBe('1000');
    expect(q.integer('0', 'gid')).toBe('0');
  });

  it.each(['1000; rm -rf /', '-1', '1e3', ' 1', 'x'])('refuses %j', (value) => {
    expect(() => q.integer(value, 'uid')).toThrow('uid is not a whole number');
  });
});

describe('xml', () => {
  it('escapes the five characters XML gives meaning to', () => {
    expect(q.xml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('driveLetter', () => {
  it.each([['z', 'Z'], ['Y:', 'Y'], ['C', 'C']])('accepts %j as %s', (value, expected) => {
    expect(q.driveLetter(value)).toBe(expected);
  });

  it.each(['Z; Remove-Item C:\\ -Recurse', 'AB', '1', '$(x)', ''])('refuses %j', (value) => {
    expect(() => q.driveLetter(value)).toThrow('drive letter is not a single letter A to Z');
  });
});

describe('every copy', () => {
  it('is the same file as the one tested here', () => {
    const lambdaDir = path.join(__dirname, '..', 'lambda');
    const canonical = fs.readFileSync(path.join(lambdaDir, 's3-mount-manager', 'script-quote.js'));
    const copies = fs
      .readdirSync(lambdaDir)
      .map((dir) => path.join(lambdaDir, dir, 'script-quote.js'))
      .filter((file) => fs.existsSync(file));
    expect(copies.length).toBeGreaterThan(0);
    for (const file of copies) {
      expect({ file, same: fs.readFileSync(file).equals(canonical) }).toEqual({ file, same: true });
    }
  });
});
