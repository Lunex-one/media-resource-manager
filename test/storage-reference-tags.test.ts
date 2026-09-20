// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a reference change means for the real AWS resources of a storage record.
 *
 * The gap this covers is not a crash — it is silence. Before update-storage
 * carried references onto the real resources, a filesystem somebody made by
 * hand and bound afterwards carried no ConstellationId and no ProjectId, every
 * dollar it cost was unattributable for ever, and the record looked complete
 * the whole time. Nothing failed; a number was simply missing from a report
 * nobody had built yet.
 *
 * So these tests are about the decision rather than the calls: which tags, on
 * which resources, for which edits.
 */

const {
  REFERENCE_TAG_KEYS,
  tagChanges,
  tagTargets,
  wouldChangeAnything
} = require('../lambda/update-storage/reference-tags.js');

/** An FSx for Windows record, as the storage state machine leaves it. */
const fsxRecord = {
  storageId: 'stor-1',
  type: 'fsx-windows',
  region: 'eu-central-1',
  cloudFormationStackName: 'MRM-Storage-stor-1',
  fsxFileSystemId: 'fs-0123456789abcdef0',
  fsxResourceArn: 'arn:aws:fsx:eu-central-1:111111111111:file-system/fs-0123456789abcdef0',
  constellationId: 'res_abc',
  projectId: 'prj_x'
};

/** A Nexis record: no FSx ARN, a System Director instance instead. */
const nexisRecord = {
  storageId: 'stor-2',
  type: 'nexis',
  region: 'eu-central-1',
  systemDirectorInstanceId: 'i-0123456789abcdef0',
  constellationId: 'res_def',
  projectId: 'prj_y'
};

/** A mountpoint-s3 record. MRM creates no AWS resource for one of these. */
const mountRecord = {
  storageId: 'stor-3',
  type: 'mountpoint-s3',
  region: 'eu-central-1',
  bucketName: 'somebody-elses-bucket',
  constellationId: 'res_ghi'
};

describe('which tags a reference edit produces', () => {
  test('the keys match what the stack tags use', () => {
    // storage-cfn-worker's referenceTags() puts these same three on the
    // CreateStack call. If the two ever disagreed, a filesystem created with
    // references and one bound afterwards would carry different keys for the
    // same fact, and a cost query grouping by one would miss the other.
    expect(REFERENCE_TAG_KEYS).toEqual({
      constellationId: 'ConstellationId',
      projectId: 'ProjectId',
      externalRef: 'ExternalRef'
    });
  });

  test('a value sets its tag', () => {
    const { setTags, clearKeys } = tagChanges(fsxRecord, ['constellationId', 'projectId']);

    expect(setTags).toEqual([
      { Key: 'ConstellationId', Value: 'res_abc' },
      { Key: 'ProjectId', Value: 'prj_x' }
    ]);
    expect(clearKeys).toEqual([]);
  });

  test('an emptied reference clears its tag rather than leaving it', () => {
    // An empty value removes the attribute — that is the rule the handler
    // already writes records by. The tag has to follow: a stale tag on a bill
    // is worse than no tag, because it attributes cost to a resource that no
    // longer claims it.
    const cleared = { ...fsxRecord, projectId: '' };
    const { setTags, clearKeys } = tagChanges(cleared, ['projectId']);

    expect(setTags).toEqual([]);
    expect(clearKeys).toEqual(['ProjectId']);
  });

  test('only the fields the request touched are applied', () => {
    // The record carries a projectId, and this edit did not mention it. It is
    // left alone: re-applying on every unrelated edit would be writes nobody
    // asked for, and would put back a tag somebody had removed on purpose.
    const { setTags, clearKeys } = tagChanges(fsxRecord, ['constellationId']);

    expect(setTags).toEqual([{ Key: 'ConstellationId', Value: 'res_abc' }]);
    expect(clearKeys).toEqual([]);
  });

  test('setting one and clearing another in the same edit', () => {
    const mixed = { ...fsxRecord, externalRef: 'ticket-9', projectId: '' };
    const { setTags, clearKeys } = tagChanges(mixed, ['externalRef', 'projectId']);

    expect(setTags).toEqual([{ Key: 'ExternalRef', Value: 'ticket-9' }]);
    expect(clearKeys).toEqual(['ProjectId']);
  });

  test('a field that is not a reference is ignored', () => {
    const { setTags, clearKeys } = tagChanges({ ...fsxRecord, name: 'renamed' }, ['name']);

    expect(setTags).toEqual([]);
    expect(clearKeys).toEqual([]);
  });
});

describe('which resources carry them', () => {
  test('an FSx file system is reached by ARN', () => {
    // FSx's tagging API takes an ARN rather than an id, which is why the
    // record keeps both.
    expect(tagTargets(fsxRecord)).toEqual({
      fsxResourceArn: fsxRecord.fsxResourceArn,
      instanceId: null
    });
  });

  test('a Nexis is reached by its System Director instance', () => {
    expect(tagTargets(nexisRecord)).toEqual({
      fsxResourceArn: null,
      instanceId: 'i-0123456789abcdef0'
    });
  });

  test('a mountpoint-s3 record owns nothing to tag, and that is not a failure', () => {
    // MRM writes a row, checks the bucket is reachable, and creates no AWS
    // resource. The bucket is somebody else's and so is its cost.
    expect(tagTargets(mountRecord)).toEqual({ fsxResourceArn: null, instanceId: null });
    expect(wouldChangeAnything(mountRecord, ['constellationId'])).toBe(false);
  });

  test('a record whose stack has not finished yet has nothing to tag either', () => {
    // The state machine writes fsxResourceArn when the stack completes. A
    // reference edited before then reaches the record and no resource, and
    // the create will carry it as a stack tag anyway.
    const building = { storageId: 'stor-4', type: 'fsx-windows', constellationId: 'res_jkl' };
    expect(wouldChangeAnything(building, ['constellationId'])).toBe(false);
  });

  test('a real record with a real change does say so', () => {
    expect(wouldChangeAnything(fsxRecord, ['constellationId'])).toBe(true);
    expect(wouldChangeAnything(nexisRecord, ['projectId'])).toBe(true);
  });

  test('an edit that touches no reference changes nothing', () => {
    expect(wouldChangeAnything(fsxRecord, ['name', 'description'])).toBe(false);
  });
});
