// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * What the sign-in reads from a directory user entry, and the search filter that finds it.
 * Pure functions with no I/O, so they are tested against fixtures.
 */

// Attributes a directory may publish a user's groups in. Active Directory uses memberOf.
const GROUP_ATTRIBUTES = ['memberOf', 'member', 'groups', 'group'];

// A user is an admin when any group DN names one of these. ADMIN_GROUP_NAME is deliberately not
// read: the fork's deployments set it to a Cognito group name that does not exist in the directory.
const ADMIN_GROUP_MARKERS = [
  'aws delegated administrators',
  'aws-delegated-administrators',
  'awsdelegatedadministrators',
];

const text = (value) => {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === null ? '' : String(first);
};

const textList = (value) =>
  (Array.isArray(value) ? value : [value])
    .filter((item) => item !== undefined && item !== null)
    .map(String);

/**
 * Escape RFC 4515 filter special characters in user-supplied input before it goes into a search
 * filter. Without this a username like "*" or "admin)(cn=*" would change the filter's meaning
 * (CWE-90, LDAP injection).
 */
function escapeLdapFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (c) => {
    switch (c) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      case '\0': return '\\00';
      default: return c;
    }
  });
}

/**
 * The profile fields and admin status for a signed-in user. `entry` is the directory entry as a
 * plain object, or null when it could not be read, in which case the defaults are returned.
 */
function readUserAttributes(entry, username, domainName) {
  const result = {
    isAdmin: false,
    displayName: username,
    email: `${username}@${domainName}`,
    firstName: '',
    lastName: '',
  };
  if (!entry) return result;

  if (entry.displayName) result.displayName = text(entry.displayName);
  if (entry.mail) result.email = text(entry.mail);

  // Prefer the structured givenName/sn. Some accounts (typically service accounts) have none of
  // these, in which case the names stay empty and the frontend falls back to the user id.
  if (entry.givenName) result.firstName = text(entry.givenName);
  if (entry.sn) result.lastName = text(entry.sn);
  if (!result.firstName && !result.lastName) {
    const humanName = [entry.displayName, entry.cn, entry.name]
      .map((value) => value && text(value).trim())
      .find((value) => value && value !== username);
    if (humanName) {
      const parts = humanName.split(/\s+/);
      result.firstName = parts[0] || '';
      result.lastName = parts.slice(1).join(' ') || '';
    }
  }

  for (const attribute of GROUP_ATTRIBUTES) {
    if (!entry[attribute]) continue;
    result.isAdmin = textList(entry[attribute]).some((group) => {
      const lower = group.toLowerCase();
      return ADMIN_GROUP_MARKERS.some((marker) => lower.includes(marker));
    });
    if (result.isAdmin) break;
  }
  return result;
}

module.exports = { readUserAttributes, escapeLdapFilter };
