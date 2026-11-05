// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The S3 buckets workstations may mount (pipeline parameter WorkstationBucketAllowList). Exact
// bucket names only: a user on a workstation can use the instance role's credentials directly, so
// a wildcard here would reach every bucket in the account.
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function parseBucketAllowList(raw?: string): string[] {
  const names = (raw ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!BUCKET_NAME.test(name)) {
      throw new Error(
        `WorkstationBucketAllowList: "${name}" is not a plain S3 bucket name ` +
          '(lowercase letters, digits, dots and hyphens; no wildcards or ARNs).'
      );
    }
  }
  return Array.from(new Set(names));
}
