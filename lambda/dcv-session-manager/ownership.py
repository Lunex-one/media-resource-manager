# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Who a workstation belongs to — the Python half of one rule.

This mirrors `lambda/workstation-manager/ownership.js` function for function, and
the two are held to one set of vectors by `test/ownership.test.ts`. They cannot be
one file: this handler is Python and that one is JavaScript, and each Lambda is
bundled from its own source directory with no shared layer. Keep them in step the
way `authz.js` copies are kept in step.

`assignedUserId` on a workstation record holds EITHER a user id OR a group id
(`group-<uuid>`). Before this module, three call sites answered "is this caller
its assignee?" three different ways, and this handler's was the one that
normalised hardest and resolved no groups at all — so a person whose workstation
is assigned to their group could list it in the console and could not open a DCV
session on it.

See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948.
"""

from __future__ import annotations

import os
from typing import Any, Iterable, Mapping, Sequence

import boto3

#: The prefixes an identity provider puts in front of a username. A federated
#: id is offered both with and without one, because a workstation may have been
#: assigned under either form.
_IDP_PREFIXES = (
    "IdentityCenter_",
    "Okta_",
    "SAML_",
    "AzureAD_",
    "AmazonFederate_",
)


def query_id_for(username: str | None, token_type: str | None) -> str:
    """The id a caller is known by for assignment purposes.

    A Cognito user keeps the whole username, because an Identity Center or Okta
    username carries a prefix that is part of the identity. An LDAP user loses
    any `@domain`, because Directory Services knows them by sAMAccountName.
    """
    if not username:
        return ""
    if token_type == "cognito":
        return username
    return username.split("@", 1)[0] if "@" in username else username


def assignment_ids_for(username: str | None, token_type: str | None) -> list[str]:
    """Every id a workstation may carry and still be this caller's.

    The prefix-stripped variant exists because Identity Center sync stores a
    userId without the `IdentityCenter_` prefix while the Cognito username after
    login includes it, so a workstation assigned before the user first logged in
    carries the short form and one assigned afterwards carries the long one.
    """
    query_id = query_id_for(username, token_type)
    if not query_id:
        return []
    variants = [query_id]
    if "_" in query_id:
        stripped = query_id.split("_", 1)[1]
        if stripped and stripped != query_id:
            variants.append(stripped)
    return variants


def assignment_matches(
    assigned_user_id: str | None,
    assignment_ids: Sequence[str],
    group_ids: Iterable[str],
) -> bool:
    """Whether a workstation carrying `assigned_user_id` is this caller's. Pure.

    **An id must match exactly.** This handler used to compare a lowercased,
    domain-stripped, prefix-stripped form of both sides, which admitted a
    workstation assigned as `Jane@corp` to a caller called `jane`. That is dropped
    rather than folded in: an identity that only matches once it has been filed
    down is an identity nobody can reason about, and the console is what writes
    `assignedUserId` in the first place.

    An unassigned workstation belongs to nobody. Answering `True` for one would
    hand every unassigned machine in the facility to every user.
    """
    if not assigned_user_id:
        return False
    return assigned_user_id in assignment_ids or assigned_user_id in group_ids


def _groups() -> list[Mapping[str, Any]]:
    """Every group this deployment knows about, or none if the table cannot be read."""
    table_name = os.environ.get("GROUPS_TABLE_NAME")
    if not table_name:
        return []
    try:
        table = boto3.resource("dynamodb").Table(table_name)
        return list(table.scan().get("Items", []))
    except Exception as error:  # noqa: BLE001 - one unreadable table must not deny a caller
        print(f"Could not read the groups table: {error}")
        return []


def _directory_id() -> str | None:
    """The managed directory's id, from SSM or by asking Directory Service."""
    pascal_case_name = os.environ.get("PASCAL_CASE_NAME", "MediaResourceManager")
    try:
        ssm = boto3.client("ssm")
        parameter = ssm.get_parameter(Name=f"/{pascal_case_name}/Identity/ActiveDirectoryId")
        return parameter["Parameter"]["Value"]
    except Exception:  # noqa: BLE001 - the parameter is optional; fall back to discovery
        pass
    try:
        directories = boto3.client("ds").describe_directories()
        described = directories.get("DirectoryDescriptions") or []
        return described[0]["DirectoryId"] if described else None
    except Exception as error:  # noqa: BLE001
        print(f"Could not resolve the directory id: {error}")
        return None


def resolve_group_ids(username: str | None, token_type: str | None) -> list[str]:
    """The group ids this caller belongs to.

    Cognito mode reads membership out of the groups table, where user-group-manager
    writes it. LDAP mode reads it live from Directory Services, where
    `assignUsersToGroupsLDAP` writes it — the groups table only says which groups
    exist.

    A group that cannot be read is skipped rather than raised on, so one
    unreadable group does not deny a caller the machines assigned to them directly.
    """
    query_id = query_id_for(username, token_type)
    if not query_id:
        return []

    groups = _groups()
    if not groups:
        return []

    if token_type == "cognito":
        member_variants = assignment_ids_for(username, token_type)
        return [
            str(group.get("groupId"))
            for group in groups
            if any(member in member_variants for member in group.get("members") or [])
            and group.get("groupId")
        ]

    directory_id = _directory_id()
    if not directory_id:
        return []

    client = boto3.client("ds-data")
    found: list[str] = []
    for group in groups:
        group_name = "".join(
            character
            for character in str(group.get("groupName") or "")
            if character.isalnum() or character in "-_."
        )
        if not group_name or not group.get("groupId"):
            continue
        try:
            members = client.list_group_members(
                DirectoryId=directory_id, SAMAccountName=group_name
            )
        except Exception as error:  # noqa: BLE001
            print(f"Could not read members of group {group_name}: {error}")
            continue
        names = [member.get("SAMAccountName") for member in members.get("Members") or []]
        if query_id in names:
            found.append(str(group["groupId"]))
    return found


def may_operate(
    *,
    username: str | None,
    token_type: str | None,
    is_admin: bool,
    assigned_user_id: str | None,
) -> bool:
    """Whether this caller may act on a workstation with this `assigned_user_id`.

    Administrators may act on anything. Everyone else must be the assignee,
    directly or through a group. The groups are resolved only when the direct
    match fails, so the ordinary case — a machine assigned to the person sitting
    at it — costs no Directory Services calls at all.
    """
    if is_admin:
        return True
    if not username or not assigned_user_id:
        return False
    assignment_ids = assignment_ids_for(username, token_type)
    if assignment_matches(assigned_user_id, assignment_ids, ()):
        return True
    return assignment_matches(
        assigned_user_id, assignment_ids, resolve_group_ids(username, token_type)
    )
