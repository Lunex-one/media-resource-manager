// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Creating the bucket behind a mountpoint-s3 record with `createBucket: true`.
 *
 * Two things matter here. The settings MRM fixes on the bucket (name, region, public access,
 * encryption, TLS-only policy, tags) must be the ones agreed, because the caller cannot choose
 * them. And a create that fails part-way must not leave a bucket behind that exists but is only
 * half configured - for example one with no public access block.
 */

const {
  validateCreateBucketRequest,
  managedBucketName,
  createBucketInput,
  tlsOnlyBucketPolicy,
  bucketTags,
  createManagedBucket
} = require('../lambda/create-storage/managed-bucket.js');

const STORAGE_ID = '3f2b7c1e-9a4d-4e55-8c21-0d6f1a2b3c4d';
const BUCKET = `mrm-storage-${STORAGE_ID}`;

/** An S3 client that records each command and fails on the ones named. */
class FakeS3 {
  calls: { name: string; input: any }[] = [];
  constructor(private failOn: string[] = []) {}

  async send(command: any) {
    const name = command.constructor.name;
    this.calls.push({ name, input: command.input });
    if (this.failOn.includes(name)) {
      throw new Error(`${name} refused`);
    }
    return {};
  }

  names() {
    return this.calls.map((c) => c.name);
  }
}

describe('validating a createBucket request', () => {
  test('createBucket with a bucketName is refused', () => {
    // MRM names the bucket itself; a caller's name would be ignored or mistaken for it.
    expect(validateCreateBucketRequest({ createBucket: true, bucketName: 'mine' })).toMatch(
      /bucketName must not be set/
    );
  });

  test('createBucket alone is accepted', () => {
    expect(validateCreateBucketRequest({ createBucket: true, mountPath: '/mnt/media' })).toBeNull();
  });

  test('a request that does not ask for a bucket is not this check\'s business', () => {
    expect(validateCreateBucketRequest({ bucketName: 'existing' })).toBeNull();
  });
});

describe('the bucket name', () => {
  test('is <acronym>-storage-<storageId>, lower case', () => {
    expect(managedBucketName('MRM', STORAGE_ID)).toBe(BUCKET);
  });

  test('stays within S3\'s 63 characters for a UUID storage id', () => {
    expect(managedBucketName('MRM', STORAGE_ID).length).toBeLessThanOrEqual(63);
  });

  test('a missing acronym fails rather than naming the bucket "undefined-storage-..."', () => {
    expect(() => managedBucketName(undefined, STORAGE_ID)).toThrow(/ACRONYM/);
  });

  test('an acronym too long for a legal name fails before any call', () => {
    expect(() => managedBucketName('A'.repeat(20), STORAGE_ID)).toThrow(/valid S3 bucket name/);
  });
});

describe('the region', () => {
  test('us-east-1 takes no LocationConstraint', () => {
    // S3 refuses an explicit constraint naming its default region.
    expect(createBucketInput(BUCKET, 'us-east-1')).toEqual({ Bucket: BUCKET });
  });

  test('every other region names itself', () => {
    expect(createBucketInput(BUCKET, 'eu-central-1')).toEqual({
      Bucket: BUCKET,
      CreateBucketConfiguration: { LocationConstraint: 'eu-central-1' }
    });
  });
});

describe('the bucket policy', () => {
  test('denies every request not made over TLS, on the bucket and its objects', () => {
    // The statement CDK's enforceSSL produces on MRM's media bucket.
    expect(tlsOnlyBucketPolicy(BUCKET)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } }
        }
      ]
    });
  });
});

describe('the tags', () => {
  test('ConstellationId and ProjectId, when sent', () => {
    expect(bucketTags({ constellationId: 'res_abc', projectId: 'prj_x' })).toEqual([
      { Key: 'ConstellationId', Value: 'res_abc' },
      { Key: 'ProjectId', Value: 'prj_x' }
    ]);
  });

  test('only the ones sent; an empty value is not a tag', () => {
    expect(bucketTags({ constellationId: 'res_abc', projectId: '' })).toEqual([
      { Key: 'ConstellationId', Value: 'res_abc' }
    ]);
  });

  test('ExternalRef is not tagged, because it is edited later and the tag would go stale', () => {
    expect(bucketTags({ externalRef: 'ticket-9' })).toEqual([]);
  });
});

describe('creating the bucket', () => {
  const tags = [{ Key: 'ConstellationId', Value: 'res_abc' }];

  test('creates, then blocks public access, encrypts, applies the policy and tags', async () => {
    const s3 = new FakeS3();
    await createManagedBucket(s3, { bucketName: BUCKET, region: 'eu-central-1', tags });

    expect(s3.names()).toEqual([
      'CreateBucketCommand',
      'PutPublicAccessBlockCommand',
      'PutBucketEncryptionCommand',
      'PutBucketPolicyCommand',
      'PutBucketTaggingCommand'
    ]);

    const [create, block, encrypt, policy, tagging] = s3.calls.map((c) => c.input);
    expect(create.CreateBucketConfiguration).toEqual({ LocationConstraint: 'eu-central-1' });
    expect(block.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true
    });
    expect(encrypt.ServerSideEncryptionConfiguration.Rules).toEqual([
      { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }
    ]);
    expect(JSON.parse(policy.Policy)).toEqual(tlsOnlyBucketPolicy(BUCKET));
    expect(tagging.Tagging).toEqual({ TagSet: tags });
  });

  test('no versioning call is made', async () => {
    const s3 = new FakeS3();
    await createManagedBucket(s3, { bucketName: BUCKET, region: 'eu-central-1', tags });
    expect(s3.names()).not.toContain('PutBucketVersioningCommand');
  });

  test('with no references, no tagging call is made', async () => {
    const s3 = new FakeS3();
    await createManagedBucket(s3, { bucketName: BUCKET, region: 'us-east-1', tags: [] });
    expect(s3.names()).not.toContain('PutBucketTaggingCommand');
  });

  test('a step failing after CreateBucket deletes the bucket and surfaces the error', async () => {
    const s3 = new FakeS3(['PutBucketPolicyCommand']);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      createManagedBucket(s3, { bucketName: BUCKET, region: 'eu-central-1', tags })
    ).rejects.toThrow('PutBucketPolicyCommand refused');

    expect(s3.names()).toEqual([
      'CreateBucketCommand',
      'PutPublicAccessBlockCommand',
      'PutBucketEncryptionCommand',
      'PutBucketPolicyCommand',
      'DeleteBucketCommand'
    ]);
    expect(s3.calls[4].input).toEqual({ Bucket: BUCKET });
    quiet.mockRestore();
  });

  test('a failed clean-up does not hide why the create failed', async () => {
    const s3 = new FakeS3(['PutPublicAccessBlockCommand', 'DeleteBucketCommand']);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      createManagedBucket(s3, { bucketName: BUCKET, region: 'eu-central-1', tags })
    ).rejects.toThrow('PutPublicAccessBlockCommand refused');
    quiet.mockRestore();
  });

  test('a failed CreateBucket has nothing to clean up', async () => {
    const s3 = new FakeS3(['CreateBucketCommand']);

    await expect(
      createManagedBucket(s3, { bucketName: BUCKET, region: 'eu-central-1', tags })
    ).rejects.toThrow('CreateBucketCommand refused');
    expect(s3.names()).toEqual(['CreateBucketCommand']);
  });
});
