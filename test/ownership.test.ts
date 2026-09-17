// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the workstation ownership rule.
 *
 * `assignedUserId` on a workstation record holds either a user id or a group id,
 * and three call sites used to answer "is this caller its assignee?" three
 * different ways — the listing matched id variants and resolved groups, the
 * lifecycle gate compared one string exactly, and dcv-session-manager compared a
 * filed-down form and resolved no groups. A user whose workstation is assigned to
 * their group could therefore see it in the console and could neither start it
 * nor connect to it.
 *
 * These vectors hold the single rule. `ownership.py` in lambda/dcv-session-manager
 * mirrors this module function for function and must answer the same way for
 * every case below.
 *
 * See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ownership = require('../lambda/workstation-manager/ownership.js');
const { queryIdFor, assignmentIdsFor, assignmentMatches, resolveGroupIds, mayOperate } = ownership;

const NO_GROUPS: string[] = [];

/** Deps whose group lookup is answerable in memory and touches no AWS. */
function depsWithGroups(groups: Record<string, unknown>[], members: string[] = []) {
  return {
    dynamodb: { send: async () => ({ Items: groups }) },
    directoryServiceData: {
      send: async () => ({ Members: members.map((name) => ({ SAMAccountName: name })) })
    },
    getDirectoryId: async () => 'd-1234567890',
    groupsTableName: 'groups'
  };
}

/** Deps that throw if touched, for asserting that a decision cost no lookups. */
function depsThatMustNotBeUsed() {
  const refuse = async () => {
    throw new Error('should not be reached');
  };
  return {
    dynamodb: { send: refuse },
    directoryServiceData: { send: refuse },
    getDirectoryId: refuse,
    groupsTableName: 'groups'
  };
}

describe('queryIdFor', () => {
  it('keeps the whole username for a Cognito caller, prefix included', () => {
    expect(queryIdFor('IdentityCenter_jane@corp.com', 'cognito')).toBe(
      'IdentityCenter_jane@corp.com'
    );
  });

  it('drops the domain for an LDAP caller, because AD knows sAMAccountName', () => {
    expect(queryIdFor('jane@corp.com', 'ldap')).toBe('jane');
  });

  it('is empty for a caller with no username, rather than throwing', () => {
    expect(queryIdFor(null, 'ldap')).toBe('');
    expect(queryIdFor(undefined, 'cognito')).toBe('');
  });
});

describe('assignmentIdsFor', () => {
  it('offers the prefixed and unprefixed forms of a federated id', () => {
    // Identity Center sync stores the short form; the Cognito username after
    // login carries the prefix. A workstation may have been assigned either way.
    expect(assignmentIdsFor('IdentityCenter_jane', 'cognito')).toEqual([
      'IdentityCenter_jane',
      'jane'
    ]);
  });

  it('offers one form where there is no prefix to strip', () => {
    expect(assignmentIdsFor('jane', 'ldap')).toEqual(['jane']);
  });

  it('offers nothing for a caller with no username', () => {
    expect(assignmentIdsFor(null, 'cognito')).toEqual([]);
  });
});

describe('assignmentMatches', () => {
  it('admits the caller a workstation is assigned to by name', () => {
    expect(assignmentMatches('jane', ['jane'], NO_GROUPS)).toBe(true);
  });

  it('admits the caller through the unprefixed form of their id', () => {
    expect(assignmentMatches('jane', ['IdentityCenter_jane', 'jane'], NO_GROUPS)).toBe(true);
  });

  it('admits the caller through a group they belong to', () => {
    // The case this change exists for: the listing showed the machine and the
    // gate turned the caller away.
    expect(assignmentMatches('group-abc', ['jane'], ['group-abc'])).toBe(true);
  });

  it('requires an exact id and does not match a differently spelled one', () => {
    expect(assignmentMatches('Jane@corp.com', ['jane'], NO_GROUPS)).toBe(false);
    expect(assignmentMatches('JANE', ['jane'], NO_GROUPS)).toBe(false);
  });

  it('refuses a caller who is neither the assignee nor in the group', () => {
    expect(assignmentMatches('group-abc', ['bob'], ['group-xyz'])).toBe(false);
  });

  it('refuses everyone on an unassigned workstation', () => {
    // Answering true here would hand every unassigned machine to every user.
    expect(assignmentMatches(null, ['jane'], ['group-abc'])).toBe(false);
    expect(assignmentMatches('', ['jane'], ['group-abc'])).toBe(false);
  });

  it('refuses a caller with no ids at all', () => {
    expect(assignmentMatches('jane', [], NO_GROUPS)).toBe(false);
  });
});

describe('resolveGroupIds', () => {
  it('finds a Cognito caller in the groups table under either form of their id', async () => {
    const groups = [
      { groupId: 'group-editors', members: ['jane'] },
      { groupId: 'group-admins', members: ['bob'] }
    ];
    const found = await resolveGroupIds(
      { username: 'IdentityCenter_jane', tokenType: 'cognito' },
      depsWithGroups(groups)
    );
    expect(found).toEqual(['group-editors']);
  });

  it('finds an LDAP caller through Directory Services membership', async () => {
    const groups = [{ groupId: 'group-editors', groupName: 'Editors' }];
    const found = await resolveGroupIds(
      { username: 'jane@corp.com', tokenType: 'ldap' },
      depsWithGroups(groups, ['jane', 'bob'])
    );
    expect(found).toEqual(['group-editors']);
  });

  it('finds nothing for a caller who is in no group', async () => {
    const groups = [{ groupId: 'group-editors', members: ['bob'] }];
    const found = await resolveGroupIds(
      { username: 'jane', tokenType: 'cognito' },
      depsWithGroups(groups)
    );
    expect(found).toEqual([]);
  });

  it('returns nothing rather than throwing when the groups table cannot be read', async () => {
    const deps = {
      ...depsWithGroups([]),
      dynamodb: {
        send: async () => {
          throw new Error('AccessDenied');
        }
      }
    };
    await expect(
      resolveGroupIds({ username: 'jane', tokenType: 'cognito' }, deps)
    ).resolves.toEqual([]);
  });

  it('skips a group whose members cannot be read instead of denying the caller', async () => {
    const groups = [{ groupId: 'group-broken', groupName: 'Broken' }];
    const deps = {
      ...depsWithGroups(groups),
      directoryServiceData: {
        send: async () => {
          throw new Error('DirectoryUnavailable');
        }
      }
    };
    await expect(resolveGroupIds({ username: 'jane', tokenType: 'ldap' }, deps)).resolves.toEqual(
      []
    );
  });
});

describe('mayOperate', () => {
  const groups = [{ groupId: 'group-editors', members: ['jane'] }];

  it('admits an administrator without looking anything up', async () => {
    await expect(
      mayOperate(
        { isAdmin: true, username: 'root', tokenType: 'cognito' },
        'jane',
        depsThatMustNotBeUsed()
      )
    ).resolves.toBe(true);
  });

  it('admits the direct assignee without resolving any groups', async () => {
    // The ordinary case — a machine assigned to the person sitting at it — must
    // cost no Directory Services calls.
    await expect(
      mayOperate(
        { isAdmin: false, username: 'jane', tokenType: 'cognito' },
        'jane',
        depsThatMustNotBeUsed()
      )
    ).resolves.toBe(true);
  });

  it('admits a caller through their group', async () => {
    await expect(
      mayOperate(
        { isAdmin: false, username: 'jane', tokenType: 'cognito' },
        'group-editors',
        depsWithGroups(groups)
      )
    ).resolves.toBe(true);
  });

  it('refuses a caller who belongs to no group holding the machine', async () => {
    await expect(
      mayOperate(
        { isAdmin: false, username: 'bob', tokenType: 'cognito' },
        'group-editors',
        depsWithGroups(groups)
      )
    ).resolves.toBe(false);
  });

  it('refuses a caller with no username', async () => {
    await expect(
      mayOperate(
        { isAdmin: false, username: null, tokenType: null },
        'jane',
        depsWithGroups(groups)
      )
    ).resolves.toBe(false);
  });

  it('refuses everyone on an unassigned workstation', async () => {
    await expect(
      mayOperate(
        { isAdmin: false, username: 'jane', tokenType: 'cognito' },
        null,
        depsWithGroups(groups)
      )
    ).resolves.toBe(false);
  });
});
