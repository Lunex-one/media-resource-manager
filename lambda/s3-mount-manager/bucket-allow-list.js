// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The buckets a workstation may mount are the ones in the deployment's WorkstationBucketAllowList,
// which is also all the workstation role's IAM policy allows. Refusing here turns an "access
// denied" inside the VM into a message the administrator can act on.

function allowedBuckets(raw) {
  return String(raw || '').split(',').map((name) => name.trim()).filter(Boolean);
}

function assertBucketAllowed(bucketName, raw) {
  if (!allowedBuckets(raw).includes(bucketName)) {
    throw new Error(
      `Bucket ${bucketName} is not on this deployment's workstation bucket allow-list. ` +
        'An administrator can add it with the WorkstationBucketAllowList pipeline parameter.'
    );
  }
}

module.exports = { allowedBuckets, assertBucketAllowed };
