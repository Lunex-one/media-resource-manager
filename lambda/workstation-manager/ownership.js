// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Who a workstation belongs to, answered in one place.
//
// `assignedUserId` on a workstation record holds EITHER a user id OR a group id
// (`group-<uuid>`) — see createGroupDynamoDB / assignUsersToGroups in
// user-group-manager, and the `user-assignment-index` GSI that both are queried
// against. Three call sites answered "is this caller its assignee?" three
// different ways:
//
//   the listing            a set of user-id variants, AND the caller's groups
//   the lifecycle gate     one string compared for exact equality, no groups
//   dcv-session-manager    IdP prefix and @domain stripped, lowercased, no groups
//
// The second was `authz.requireSelfOrAdmin`, which this replaces and which is
// deleted: a shared authorization helper with no callers is one nobody is
// keeping true.
//
// The listing was the most generous of the three, so a user could SEE a
// group-assigned workstation in the console and could not start, stop, reboot or
// connect to it — the Start button 403s. This module is the listing's rule,
// lifted out, so every path gives the same answer.
//
// The pure half is separated from the I/O so the rule is unit-testable without
// DynamoDB or Directory Services, and so the two language copies of it (this and
// lambda/dcv-session-manager/ownership.py) can be held to one set of vectors.
//
// See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948 for the checks this
// completes.

const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { ListGroupMembersCommand } = require('@aws-sdk/client-directory-service-data');

/**
 * The id a caller is known by for assignment purposes.
 *
 * Cognito users keep the full username, because Identity Center and Okta
 * usernames carry an IdP prefix that is part of the identity. LDAP users lose
 * any `@domain`, because Directory Services knows them by sAMAccountName.
 */
function queryIdFor(username, tokenType) {
  if (!username) {
    return '';
  }
  if (tokenType === 'cognito') {
    return username;
  }
  return username.includes('@') ? username.split('@')[0] : username;
}

/**
 * Every id a workstation may carry in `assignedUserId` and still be this
 * caller's.
 *
 * The prefix-stripped variant exists because Identity Center sync stores a
 * userId without the `IdentityCenter_` prefix, but the Cognito username after
 * login includes it — so a workstation assigned before the user first logged in
 * carries the short form and one assigned after carries the long one.
 */
function assignmentIdsFor(username, tokenType) {
  const queryId = queryIdFor(username, tokenType);
  if (!queryId) {
    return [];
  }
  const variants = [queryId];
  if (queryId.includes('_')) {
    const stripped = queryId.split('_').slice(1).join('_');
    if (stripped && stripped !== queryId) {
      variants.push(stripped);
    }
  }
  return variants;
}

/**
 * Whether a workstation carrying `assignedUserId` belongs to a caller with these
 * assignment ids and these group ids. Pure: the caller resolves the groups.
 *
 * **An id must match exactly.** dcv-session-manager used to compare a lowercased,
 * domain-stripped, prefix-stripped form of both sides, which admitted a
 * workstation assigned as `Jane@corp` to a caller called `jane`. That is dropped
 * here rather than folded in: an identity that only matches once it has been
 * filed down is an identity nobody can reason about, and the console is what
 * writes `assignedUserId` in the first place. A deployment relying on the loose
 * comparison must correct its assignments — see the release note.
 *
 * An unassigned workstation belongs to nobody. Answering `true` for one would
 * hand every unassigned machine in the facility to every user.
 */
function assignmentMatches(assignedUserId, assignmentIds, groupIds) {
  if (!assignedUserId) {
    return false;
  }
  return assignmentIds.includes(assignedUserId) || groupIds.includes(assignedUserId);
}

/**
 * The group ids this caller belongs to.
 *
 * Cognito mode reads membership out of the groups table, which is where
 * user-group-manager writes it. LDAP mode reads it live from Directory
 * Services, because that is where `assignUsersToGroupsLDAP` writes it — the
 * groups table only says which groups exist.
 *
 * A group that cannot be read is skipped rather than raised on, so one
 * unreadable group does not deny a caller their directly assigned machines.
 */
async function resolveGroupIds({ username, tokenType }, deps) {
  const { dynamodb, directoryServiceData, getDirectoryId, groupsTableName } = deps;
  const queryId = queryIdFor(username, tokenType);
  if (!queryId) {
    return [];
  }

  let groups;
  try {
    const result = await dynamodb.send(new ScanCommand({ TableName: groupsTableName }));
    groups = result.Items || [];
  } catch (error) {
    console.log('Could not read the groups table:', error);
    return [];
  }

  if (tokenType === 'cognito') {
    const memberVariants = assignmentIdsFor(username, tokenType);
    return groups
      .filter((group) => (group.members || []).some((m) => memberVariants.includes(m)))
      .map((group) => group.groupId);
  }

  let directoryId;
  try {
    directoryId = await getDirectoryId();
  } catch (error) {
    console.log('Could not resolve the directory id:', error);
    return [];
  }

  const memberships = await Promise.all(
    groups.map(async (group) => {
      const sanitizedGroupName = String(group.groupName || '').replace(/[^a-zA-Z0-9\-_.]/g, '');
      if (!sanitizedGroupName) {
        return null;
      }
      try {
        const members = await directoryServiceData.send(new ListGroupMembersCommand({
          DirectoryId: directoryId,
          SAMAccountName: sanitizedGroupName
        }));
        const names = (members.Members || []).map((member) => member.SAMAccountName);
        return names.includes(queryId) ? group.groupId : null;
      } catch (error) {
        console.log('Could not read members of group', sanitizedGroupName + ':', error);
        return null;
      }
    })
  );

  return memberships.filter((groupId) => groupId !== null);
}

/**
 * Whether this caller may operate a workstation with this `assignedUserId`.
 *
 * Administrators may operate anything. Everyone else must be the assignee,
 * directly or through a group. The groups are only resolved when the direct
 * match fails, so the ordinary case — a machine assigned to the person using it
 * — costs no Directory Services calls at all.
 */
async function mayOperate(identity, assignedUserId, deps) {
  if (identity.isAdmin) {
    return true;
  }
  if (!identity.username || !assignedUserId) {
    return false;
  }
  const assignmentIds = assignmentIdsFor(identity.username, identity.tokenType);
  if (assignmentMatches(assignedUserId, assignmentIds, [])) {
    return true;
  }
  const groupIds = await resolveGroupIds(identity, deps);
  return assignmentMatches(assignedUserId, assignmentIds, groupIds);
}

module.exports = {
  queryIdFor,
  assignmentIdsFor,
  assignmentMatches,
  resolveGroupIds,
  mayOperate
};
