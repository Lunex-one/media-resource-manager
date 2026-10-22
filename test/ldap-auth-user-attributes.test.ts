// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the LDAP sign-in reads from a directory entry. The JWT's admin flag and the JIT user record
 * both come from this, so an admin who stops being recognised, or a name field that silently
 * empties, is a real regression that no type check would catch.
 */

const { readUserAttributes, escapeLdapFilter } = require('../lambda/ldap-auth/user-attributes.js');

const DOMAIN = 'studio.mrm.internal';
const ADMIN_GROUP = 'CN=AWS Delegated Administrators,OU=AWS Delegated Groups,DC=studio,DC=mrm,DC=internal';
const OTHER_GROUP = 'CN=AssistantEditors,OU=Groups,DC=studio,DC=mrm,DC=internal';

describe('readUserAttributes', () => {
  test('returns the defaults when the entry could not be read', () => {
    expect(readUserAttributes(null, 'richard', DOMAIN)).toEqual({
      isAdmin: false,
      displayName: 'richard',
      email: `richard@${DOMAIN}`,
      firstName: '',
      lastName: '',
    });
  });

  test('reads a fully populated entry', () => {
    const entry = {
      displayName: 'Richard Duke',
      mail: 'richard@lunex.one',
      givenName: 'Richard',
      sn: 'Duke',
      memberOf: [OTHER_GROUP, ADMIN_GROUP],
    };
    expect(readUserAttributes(entry, 'richard', DOMAIN)).toEqual({
      isAdmin: true,
      displayName: 'Richard Duke',
      email: 'richard@lunex.one',
      firstName: 'Richard',
      lastName: 'Duke',
    });
  });

  test('recognises an admin whose only group is published as a single string', () => {
    expect(readUserAttributes({ memberOf: ADMIN_GROUP }, 'a', DOMAIN).isAdmin).toBe(true);
  });

  test('is not admin without the admin group', () => {
    expect(readUserAttributes({ memberOf: [OTHER_GROUP] }, 'a', DOMAIN).isAdmin).toBe(false);
    expect(readUserAttributes({}, 'a', DOMAIN).isAdmin).toBe(false);
  });

  test('matches the admin group case-insensitively and in its dashed forms', () => {
    const groups: string[] = [
      'CN=aws delegated administrators,DC=x',
      'CN=AWS-Delegated-Administrators,DC=x',
      'CN=AWSDelegatedAdministrators,DC=x',
    ];
    for (const group of groups) {
      expect(readUserAttributes({ memberOf: [group] }, 'a', DOMAIN).isAdmin).toBe(true);
    }
  });

  test('splits a display name when givenName and sn are not published', () => {
    const result = readUserAttributes({ displayName: 'Tilman Van Der Berg' }, 'tilman', DOMAIN);
    expect(result.firstName).toBe('Tilman');
    expect(result.lastName).toBe('Van Der Berg');
  });

  test('does not treat the user id as a human name', () => {
    const result = readUserAttributes({ displayName: 'svc-keycloak', cn: 'svc-keycloak' }, 'svc-keycloak', DOMAIN);
    expect(result.firstName).toBe('');
    expect(result.lastName).toBe('');
  });

  test('uses the structured names over a display name when they exist', () => {
    const result = readUserAttributes({ displayName: 'Dr R. Duke', givenName: 'Richard', sn: 'Duke' }, 'richard', DOMAIN);
    expect([result.firstName, result.lastName]).toEqual(['Richard', 'Duke']);
  });

  test('takes the first value of a multi-valued attribute', () => {
    expect(readUserAttributes({ mail: ['first@x.io', 'second@x.io'] }, 'a', DOMAIN).email).toBe('first@x.io');
  });
});

describe('escapeLdapFilter', () => {
  test('leaves an ordinary user name alone', () => {
    expect(escapeLdapFilter('richard.duke-2')).toBe('richard.duke-2');
  });

  test.each([
    ['*', '\\2a'],
    ['(', '\\28'],
    [')', '\\29'],
    ['\\', '\\5c'],
    ['\0', '\\00'],
  ])('escapes %j', (input: string, expected: string) => {
    expect(escapeLdapFilter(input)).toBe(expected);
  });

  test('neutralises a filter-injection attempt', () => {
    const escaped: string = escapeLdapFilter('admin)(cn=*');
    expect(escaped).toBe('admin\\29\\28cn=\\2a');
    expect(escaped).not.toMatch(/[()*]/);
  });
});
