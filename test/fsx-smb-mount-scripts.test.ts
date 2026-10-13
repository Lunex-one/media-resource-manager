// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The logon script `lambda/fsx-smb-mount-manager` writes to a Windows workstation, and the SSM
 * commands that write it, built from records whose every value was written to break out.
 *
 * Until these went through `script-quote.js`, a storage name, a drive letter and a share name were
 * pasted into PowerShell comments and double-quoted strings in a script run at every user's logon,
 * and the script itself was pasted into a single-quoted here-string run as SYSTEM, which a line
 * beginning `'@` ended. PowerShell is not installed where these tests run, so they check where
 * each value ends up rather than running it.
 *
 * Hermetic: `scripts.js` imports nothing but the quoting helper.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const scripts = require('../lambda/fsx-smb-mount-manager/scripts.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const q = require('../lambda/fsx-smb-mount-manager/script-quote.js');

const NAME = `Media $(Remove-Item C:\\ -Recurse) "dq" 'sq' ‘curly’ @'`;

const windowsStorage = {
  storageId: '3f2a9c1e-0000-4000-8000-000000000001',
  type: 'fsx-windows',
  name: NAME,
  fsxDnsName: `amznfsx$(whoami).corp.example`,
  driveLetter: 'y',
};

const ontapStorage = {
  storageId: '3f2a9c1e-0000-4000-8000-000000000002',
  type: 'fsx-ontap',
  name: NAME,
  svmDnsName: `svm$(whoami).fsx.example`,
  shareName: `vol1$(whoami)`,
  driveLetter: 'X',
};

const credentials = { username: `svc$(whoami)`, password: `pa'ss‘word$(x)` };
const ontapCredentials = {
  [ontapStorage.storageId]: { username: `CIFS\\smbuser`, password: `o'n‘t$(x)`, shareName: `vol1$(x)` },
};

/** Every line of a script that is not a single-quoted literal assignment such as `$x = '...'`. */
function nonLiteralLines(script: string): string[] {
  return script.split('\n').filter((line) => !/^\s*\$[A-Za-z]+ = '/.test(line));
}

/** The record values that must never appear outside a literal assignment. */
const VALUES = [
  NAME,
  windowsStorage.fsxDnsName,
  ontapStorage.svmDnsName,
  ontapStorage.shareName,
  credentials.username,
  credentials.password,
  ontapCredentials[ontapStorage.storageId].password,
];

describe.each([
  ['domain-joined', true, null, null],
  ['standalone', false, credentials, 'corp.example'],
])('the logon script, %s', (_label, joined, creds, domain) => {
  const script: string = scripts.generateLoginScript([windowsStorage, ontapStorage], joined, creds, domain, ontapCredentials);

  it('mentions a record value only on a line that assigns it as a literal', () => {
    for (const line of nonLiteralLines(script)) {
      for (const value of VALUES) {
        expect(line).not.toContain(value);
      }
    }
  });

  it('assigns the storage name as a literal', () => {
    expect(script).toContain(`$mountName = ${q.ps(NAME)}`);
  });

  it('writes no record value into a comment', () => {
    const comments = script.split('\n').filter((line) => line.trim().startsWith('#'));
    for (const comment of comments) {
      expect(comment).not.toContain('Media');
      expect(comment).not.toContain('$(whoami)');
    }
  });

  it('uses the validated, upper-cased drive letters as bare words', () => {
    expect(script).toContain('net use Y: /delete /y');
    expect(script).toContain('net use X: /delete /y');
  });

  it('never writes "<variable>:" inside a double-quoted string, which PowerShell reads as a drive', () => {
    expect(script).not.toMatch(/\$[A-Za-z]+: /);
  });
});

describe('the domain-joined flag', () => {
  it('is written as true or false, never as the domain id a record carries', () => {
    const script = scripts.generateLoginScript([], 'd-1234567890$(whoami)', null, null);
    expect(script).toContain('# Domain-joined: true');
    expect(script).not.toContain('d-1234567890');
  });
});

describe('a drive letter', () => {
  it('defaults to Z', () => {
    const script = scripts.generateLoginScript([{ ...windowsStorage, driveLetter: undefined }], true, null, null);
    expect(script).toContain('net use Z: /delete /y');
  });

  it.each(['Z; Remove-Item C:\\ -Recurse', 'AB', '$(x)'])('is refused when it is %j', (letter) => {
    expect(() => scripts.generateLoginScript([{ ...windowsStorage, driveLetter: letter }], true, null, null)).toThrow(
      'drive letter is not a single letter A to Z',
    );
  });
});

describe('a value no script can carry', () => {
  it('is refused before any script exists', () => {
    expect(() =>
      scripts.generateLoginScript([{ ...windowsStorage, name: `x\n'@\nRemove-Item C:\\` }], true, null, null),
    ).toThrow(q.UnsafeValueError);
  });
});

describe('the SSM commands that install the script', () => {
  const script: string = scripts.generateLoginScript([windowsStorage, ontapStorage], true, null, null, ontapCredentials);
  const commands: string[] = scripts.deployCommands(script);

  it('carry the script base64-encoded, so nothing in it can end the string that carries it', () => {
    const line = commands.find((c) => c.startsWith('$scriptContent = '));
    expect(line).toBeDefined();
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(line as string);
    expect(encoded).not.toBeNull();
    expect(Buffer.from((encoded as RegExpExecArray)[1], 'base64').toString('utf8')).toBe(script);
  });

  it('use no here-string', () => {
    expect(commands.some((c) => c.includes("@'") || c === "'@")).toBe(false);
  });

  it('hold no record value in plain text', () => {
    for (const command of commands) {
      expect(command).not.toContain('Media');
    }
  });
});
