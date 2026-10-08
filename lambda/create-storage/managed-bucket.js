// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Creating the S3 bucket behind a mountpoint-s3 record with `createBucket: true`.
 *
 * Split out of index.js for the reason reference-tags.js is split out of update-storage: the
 * handler cannot be loaded in a test, and the parts worth checking are either pure decisions
 * (the name, the region constraint, the policy, the tags) or a short sequence of calls that can
 * be run against a fake client. index.js owns the request handling and the record write.
 *
 * Every setting here is fixed by MRM and not offered to the caller. The caller chooses the region
 * and nothing else about the bucket.
 */

const {
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  DeleteBucketCommand
} = require('@aws-sdk/client-s3');

/** S3's own rule for a general purpose bucket name: 3-63 characters, lower case, digits, '-'. */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Refuse a request that asks MRM to create a bucket and also names one.
 *
 * MRM chooses the name itself, so a caller-supplied name would either be ignored silently or be
 * mistaken for the bucket that was made. Returns an error message, or null when the request is
 * acceptable.
 */
function validateCreateBucketRequest(configuration) {
  if (configuration.createBucket !== true) return null;
  if (configuration.bucketName) {
    return 'bucketName must not be set when createBucket is true: MRM names the bucket it creates';
  }
  return null;
}

/**
 * The name of the bucket MRM creates for a storage record: `<acronym>-storage-<storageId>`.
 *
 * Bucket names are global across all AWS accounts, and the storage id is a UUID, so the name is
 * unique without a lookup. The fixed `<acronym>-storage-` prefix is what lets the create-storage
 * role's S3 grant stay limited to buckets of this shape (see lib/storage-stack.ts).
 *
 * Throws when the acronym is missing (the ACRONYM environment variable is not set) or the result
 * is not a legal bucket name, which can only happen with an unusually long acronym. Failing here
 * is better than creating 'undefined-storage-…' or a CreateBucket error that does not say why.
 */
function managedBucketName(acronym, storageId) {
  if (!acronym) {
    throw new Error('Cannot name the bucket: the deployment acronym (ACRONYM) is not set');
  }
  const name = `${String(acronym).toLowerCase()}-storage-${String(storageId).toLowerCase()}`;
  if (!BUCKET_NAME_PATTERN.test(name)) {
    throw new Error(`Cannot derive a valid S3 bucket name from acronym '${acronym}': got '${name}'`);
  }
  return name;
}

/**
 * The CreateBucket input for a region.
 *
 * us-east-1 is S3's default location and refuses an explicit LocationConstraint naming itself;
 * every other region requires one. generate-regional-hub-template creates its asset buckets the
 * same way.
 */
function createBucketInput(bucketName, region) {
  const input = { Bucket: bucketName };
  if (region && region !== 'us-east-1') {
    input.CreateBucketConfiguration = { LocationConstraint: region };
  }
  return input;
}

/**
 * The bucket policy MRM applies: refuse every request that does not arrive over TLS.
 *
 * This is the statement CDK's `enforceSSL: true` produces on MRM's own media bucket, so a bucket
 * MRM creates at run time holds the same line as the ones it creates at deploy time. It denies
 * and grants nothing else; access comes from the workstation role's IAM policy, as it does for a
 * bucket MRM only points at.
 */
function tlsOnlyBucketPolicy(bucketName) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } }
      }
    ]
  };
}

/**
 * The tags the bucket carries: ConstellationId and ProjectId, only those the caller sent.
 *
 * The same rule datasync-create-task's referenceTags() follows, for the same reasons. These two
 * are what a per-project cost query groups by, and an empty value would read as "set to nothing"
 * rather than "not set". ExternalRef is left off: the facility edits it afterwards, and
 * PUT /storage/{id} changes the record without touching the bucket's tags, so an ExternalRef tag
 * would go stale.
 */
function bucketTags(data) {
  const keys = { constellationId: 'ConstellationId', projectId: 'ProjectId' };
  return Object.entries(keys)
    .filter(([field]) => data[field])
    .map(([field, Key]) => ({ Key, Value: String(data[field]) }));
}

/**
 * Delete a bucket MRM has just created and not yet recorded, because a later step failed.
 *
 * The bucket is still empty, so S3 allows the delete. A failure here is logged and swallowed: the
 * caller is already handling the error that made the clean-up necessary, and that error is the one
 * to report. The log names the bucket so it can be removed by hand.
 */
async function deleteUnrecordedBucket(s3, bucketName) {
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
  } catch (cleanupError) {
    console.error(`Could not delete half-configured bucket ${bucketName}; remove it by hand:`, cleanupError);
  }
}

/**
 * Create the bucket and apply MRM's settings, or leave nothing behind.
 *
 * Order: CreateBucket, then the public access block, default encryption, the TLS-only policy and,
 * when there are any, the tags. If any step after CreateBucket fails, the bucket is deleted again
 * (it is still empty, so S3 allows that) and the original error is thrown, so a caller never ends
 * up with a bucket that exists but is only half configured. The storage record is written by the
 * caller after this returns, which is why a failure here also leaves no record.
 *
 * The record write that follows is the one step after CreateBucket this function does not run;
 * index.js calls deleteUnrecordedBucket itself if that write fails.
 *
 * @param s3 an S3Client for the bucket's region (anything with `send(command)`)
 */
async function createManagedBucket(s3, { bucketName, region, tags }) {
  await s3.send(new CreateBucketCommand(createBucketInput(bucketName, region)));

  try {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true
      }
    }));

    // SSE-S3, as on MRM's media bucket (s3.BucketEncryption.S3_MANAGED in lib/storage-stack.ts).
    await s3.send(new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
      }
    }));

    await s3.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(tlsOnlyBucketPolicy(bucketName))
    }));

    if (tags && tags.length > 0) {
      await s3.send(new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: { TagSet: tags }
      }));
    }
  } catch (error) {
    console.error(`Configuring bucket ${bucketName} failed; deleting it again:`, error);
    await deleteUnrecordedBucket(s3, bucketName);
    throw error;
  }
}

module.exports = {
  validateCreateBucketRequest,
  managedBucketName,
  createBucketInput,
  tlsOnlyBucketPolicy,
  bucketTags,
  createManagedBucket,
  deleteUnrecordedBucket
};
