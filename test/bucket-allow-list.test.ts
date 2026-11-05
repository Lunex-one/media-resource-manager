// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseBucketAllowList } from '../lib/bucket-allow-list';

describe('parseBucketAllowList', () => {
  test('nothing configured means no buckets', () => {
    expect(parseBucketAllowList(undefined)).toEqual([]);
    expect(parseBucketAllowList('')).toEqual([]);
    expect(parseBucketAllowList(' , ,')).toEqual([]);
  });

  test('trims, drops empties and de-duplicates', () => {
    expect(parseBucketAllowList(' mrm-media-1 , other.bucket ,,mrm-media-1')).toEqual(['mrm-media-1', 'other.bucket']);
  });

  test.each([
    '*', 'mrm-*', 'MRM-Media', 'ab', '-leading', 'trailing-', 'has space', 'a_b_c',
    'arn:aws:s3:::mrm-media', 'mrm-media/*', 'x'.repeat(64),
  ])('rejects %p', (name: string) => {
    expect(() => parseBucketAllowList(`good-bucket,${name}`)).toThrow(/WorkstationBucketAllowList/);
  });
});
