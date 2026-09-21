// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deciding what a reference change means for the real AWS resources, apart from
 * doing it.
 *
 * Split out of index.js for the reason self-heal.js is split out of
 * workstation-manager: the handler cannot be loaded in a test — it requires SDK
 * clients the runtime provides and this checkout does not — and the part worth
 * checking is a pure function of a storage record.
 *
 * What is decided here: which tags to set, which to clear, and which resources
 * to touch. What is NOT here: any call. index.js owns the I/O.
 */

/**
 * The three references, and the tag key each becomes. The same mapping
 * storage-cfn-worker's referenceTags() uses on the CreateStack call — these two
 * must agree or a filesystem created with references and one bound afterwards
 * would carry different keys for the same fact.
 */
const REFERENCE_TAG_KEYS = {
  constellationId: 'ConstellationId',
  projectId: 'ProjectId',
  externalRef: 'ExternalRef'
};

/**
 * What to set and what to clear, from the updated record and the fields the
 * request actually touched.
 *
 * ONLY the fields the request touched. A record carrying a constellationId that
 * this call did not mention is left alone rather than re-applied: re-tagging on
 * every unrelated edit would be writes nobody asked for, and — where a tag had
 * been removed at AWS on purpose — would put it back.
 *
 * An absent, null or empty value CLEARS. That is the rule create-storage and
 * this handler already write records by: an empty value removes the attribute,
 * so "nobody set this" stays distinguishable from "set to nothing". The tag has
 * to follow, because a stale tag on a bill is worse than no tag — it attributes
 * cost to a resource that no longer claims it.
 */
function tagChanges(storage, changedFields) {
  const setTags = [];
  const clearKeys = [];

  for (const field of changedFields) {
    const key = REFERENCE_TAG_KEYS[field];
    if (!key) continue;

    const value = storage?.[field];
    if (value === undefined || value === null || value === '') {
      clearKeys.push(key);
    } else {
      setTags.push({ Key: key, Value: String(value) });
    }
  }

  return { setTags, clearKeys };
}

/**
 * Which real resources a storage record owns that can carry a tag.
 *
 * THE FSx FILE SYSTEM, by the ARN the state machine recorded — FSx's tagging
 * API takes an ARN rather than an id, which is why the record keeps both.
 *
 * A NEXIS SYSTEM DIRECTOR, by instance id. Its attached volumes belong on the
 * list too and are not here, because finding them is a DescribeInstances call:
 * index.js appends them. The reason they matter is the same one the workstation
 * path records — a root volume is a billing line of its own, so a reference that
 * stops at the instance silently misses the disk.
 *
 * A MOUNTPOINT-S3 RECORD OWNS NOTHING. MRM writes a row, checks the bucket is
 * reachable, and creates no AWS resource — so there is nothing to tag and the
 * empty answer is correct rather than a failure. The bucket belongs to whoever
 * owns it and its cost is theirs.
 */
function tagTargets(storage) {
  return {
    fsxResourceArn: storage?.fsxResourceArn || null,
    instanceId: storage?.systemDirectorInstanceId || null
  };
}

/** Whether anything at all would happen, so a caller can skip the clients. */
function wouldChangeAnything(storage, changedFields) {
  const { setTags, clearKeys } = tagChanges(storage, changedFields);
  if (setTags.length === 0 && clearKeys.length === 0) return false;

  const { fsxResourceArn, instanceId } = tagTargets(storage);
  return Boolean(fsxResourceArn || instanceId);
}

module.exports = { REFERENCE_TAG_KEYS, tagChanges, tagTargets, wouldChangeAnything };
