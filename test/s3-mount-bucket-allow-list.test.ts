// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The S3 mount manager refuses to mount a bucket that is not on the deployment's allow-list, the
 * same list that bounds the workstation role's IAM policy. Unmounting is not gated here.
 */

export {};

const { allowedBuckets, assertBucketAllowed } = require('../lambda/s3-mount-manager/bucket-allow-list.js');

describe('assertBucketAllowed', () => {
  test('lets a listed bucket through', () => {
    expect(() => assertBucketAllowed('mrm-media-1', 'mrm-media-1,other')).not.toThrow();
    expect(() => assertBucketAllowed('other', ' mrm-media-1 , other ')).not.toThrow();
  });

  test('refuses an unlisted bucket with a message the administrator can act on', () => {
    expect(() => assertBucketAllowed('mrm-frontend-1', 'mrm-media-1')).toThrow(/allow-list.*WorkstationBucketAllowList/s);
  });

  test('an empty or missing list allows nothing', () => {
    expect(() => assertBucketAllowed('mrm-media-1', '')).toThrow();
    expect(() => assertBucketAllowed('mrm-media-1', undefined)).toThrow();
  });

  test('a name that merely contains a listed name is not listed', () => {
    expect(() => assertBucketAllowed('mrm-media-1-extra', 'mrm-media-1')).toThrow();
    expect(allowedBuckets('a,,b ')).toEqual(['a', 'b']);
  });
});
