// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hostname the three `hostname-set-*` Lambdas paste into a script run as root or SYSTEM.
 *
 * It is refused unless it is one DNS label, so it can never be anything but a name in that
 * script. The check is the same function in each of the three, and each is exercised here.
 *
 * Loading a handler file constructs its AWS clients but sends nothing.
 */

const lambdas = ['linux', 'macos', 'windows'].map((os) => ({
  os,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  checkedHostname: require(`../lambda/hostname-set-${os}/index.js`).checkedHostname as (h: unknown) => string,
}));

describe.each(lambdas)('hostname-set-$os', ({ checkedHostname }) => {
  it.each(['edit-0001', 'WS42', 'a', `a${'b'.repeat(61)}c`])('accepts %j', (hostname) => {
    expect(checkedHostname(hostname)).toBe(hostname);
  });

  it.each([
    null,
    undefined,
    '',
    '-leading',
    'trailing-',
    'with space',
    'dot.ted',
    'x"; reboot; "',
    'x$(reboot)',
    "x'; Restart-Computer; '",
    'line\nbreak',
    `a${'b'.repeat(62)}c`,
  ])('refuses %j', (hostname) => {
    expect(() => checkedHostname(hostname)).toThrow('Refusing to set hostname');
  });
});
