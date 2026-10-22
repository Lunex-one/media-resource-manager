// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a failed LDAP bind tells the person signing in.
 *
 * Active Directory rejects every bad bind with LDAP result 49, "Invalid Credentials", and says why
 * only in a sub-code inside the diagnostic message: 52e wrong password, 525 unknown user, 532
 * expired password, 533 disabled, 701 account expired, 773 must change, 775 locked. Until the
 * sub-code was read, an expired password looked exactly like a wrong one, which cost a login outage
 * a wrong diagnosis (lockout) before expiry was found.
 *
 * The line these tests hold is what stays generic. AD reports 532, 533, 701 and 773 only after it
 * has verified the password, so naming them tells the person something they already know. 52e, 525
 * and 775 are what an attacker would learn from, so they must stay indistinguishable.
 */

const { adBindCode, adBindReason, REASON_MESSAGES } = require('../lambda/ldap-auth/bind-errors.js');

const diagnostic = (code: string): string =>
  `80090308: LdapErr: DSID-0C090439, comment: AcceptSecurityContext error, data ${code}, v4563`;

const ALL_CODES: string[] = ['52e', '525', '532', '533', '701', '773', '775'];

describe('the AD sub-code of a failed bind', () => {
  test.each(ALL_CODES)('is read from "data %s" in either error field', (code: string) => {
    expect(adBindCode({ message: 'Invalid Credentials', lde_message: diagnostic(code) })).toBe(code);
    expect(adBindCode({ message: diagnostic(code) })).toBe(code);
  });

  test('is normalised to lower case', () => {
    expect(adBindCode({ message: diagnostic('52E') })).toBe('52e');
  });

  test('is null when the error carries none', () => {
    expect(adBindCode({ message: 'Invalid Credentials' })).toBeNull();
    expect(adBindCode({})).toBeNull();
    expect(adBindCode(null)).toBeNull();
  });
});

describe('the reason shown to the person signing in', () => {
  test.each([
    ['532', 'PASSWORD_EXPIRED'],
    ['773', 'PASSWORD_MUST_CHANGE'],
    ['533', 'ACCOUNT_DISABLED'],
    ['701', 'ACCOUNT_EXPIRED'],
  ])('names sub-code %s as %s, with a message', (code: string, reason: string) => {
    expect(adBindReason(code)).toBe(reason);
    expect(REASON_MESSAGES[reason]).toEqual(expect.any(String));
  });

  test.each(['52e', '525', '775'])(
    'keeps %s generic, so a failed sign-in reveals nothing about the account',
    (code: string) => {
      expect(adBindReason(code)).toBeUndefined();
    }
  );

  test('keeps an unknown or missing sub-code generic', () => {
    expect(adBindReason('999')).toBeUndefined();
    expect(adBindReason(null)).toBeUndefined();
  });
});
