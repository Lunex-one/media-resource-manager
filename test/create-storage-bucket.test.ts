// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /storage with `type: "mountpoint-s3"` and `configuration.createBucket: true`, through the
 * create-storage handler, with every AWS client replaced.
 *
 * managed-bucket.test.ts checks the bucket's settings and the clean-up on their own. This checks
 * what only the handler decides: that the storage record is written after the bucket is ready,
 * and not at all when creating it failed - a record pointing at a bucket that was deleted again
 * would mount nothing.
 */

const mockS3Calls: { name: string; input: any }[] = [];
let mockS3FailOn: string[] = [];
const mockDynamoCalls: { name: string; input: any }[] = [];
let mockDynamoFails = false;

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn(() => ({
      send: async (command: any) => {
        const name = command.constructor.name;
        mockS3Calls.push({ name, input: command.input });
        if (mockS3FailOn.includes(name)) throw new Error(`${name} refused`);
        return {};
      }
    }))
  };
});

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (command: any) => {
          mockDynamoCalls.push({ name: command.constructor.name, input: command.input });
          if (mockDynamoFails) throw new Error('PutCommand refused');
          return {};
        }
      })
    }
  };
});

// Not installed at the repository root; the Lambda runtime provides it. The mountpoint-s3 path
// never starts an execution, so an empty stand-in is enough.
jest.mock(
  '@aws-sdk/client-sfn',
  () => ({ SFNClient: jest.fn(() => ({})), StartExecutionCommand: jest.fn() }),
  { virtual: true }
);

process.env.AWS_REGION = 'eu-central-1';
process.env.ACRONYM = 'MRM';
process.env.STORAGE_TABLE_NAME = 'mrm-storage';

const { handler } = require('../lambda/create-storage/index.js');

function request(configuration: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    requestContext: { authorizer: { isAdmin: 'true', username: 'admin' } },
    body: JSON.stringify({
      name: 'Project Foo media',
      type: 'mountpoint-s3',
      configuration,
      ...extra
    })
  };
}

beforeEach(() => {
  mockS3Calls.length = 0;
  mockDynamoCalls.length = 0;
  mockS3FailOn = [];
  mockDynamoFails = false;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('creates the bucket, then writes a record marked managedBucket', async () => {
  const response = await handler(
    request({ createBucket: true, mountPath: '/mnt/media' }, { constellationId: 'res_abc' })
  );
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(201);
  expect(body.data.bucketName).toMatch(/^mrm-storage-[0-9a-f-]{36}$/);
  expect(body.data.bucketName).toBe(`mrm-storage-${body.data.storageId}`);
  expect(body.data.managedBucket).toBe(true);
  expect(body.data.region).toBe('eu-central-1');

  // No HeadBucket or GetBucketLocation: there is nothing to look up about a bucket just made.
  expect(mockS3Calls.map((c) => c.name)).toEqual([
    'CreateBucketCommand',
    'PutPublicAccessBlockCommand',
    'PutBucketEncryptionCommand',
    'PutBucketPolicyCommand',
    'PutBucketTaggingCommand'
  ]);

  const puts = mockDynamoCalls.filter((c) => c.name === 'PutCommand');
  expect(puts).toHaveLength(1);
  expect(puts[0].input.Item).toMatchObject({
    type: 'mountpoint-s3',
    bucketName: body.data.bucketName,
    managedBucket: true,
    region: 'eu-central-1',
    constellationId: 'res_abc',
    configuration: { createBucket: true, bucketName: body.data.bucketName }
  });
});

test('a failure after CreateBucket deletes the bucket, returns the error and writes no record', async () => {
  mockS3FailOn = ['PutBucketEncryptionCommand'];

  const response = await handler(request({ createBucket: true }));
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(500);
  expect(body.success).toBe(false);
  expect(body.details).toBe('PutBucketEncryptionCommand refused');
  expect(mockS3Calls.map((c) => c.name)).toContain('DeleteBucketCommand');
  expect(mockDynamoCalls.filter((c) => c.name === 'PutCommand')).toHaveLength(0);
});

test('a failed record write deletes the bucket too, so no unrecorded bucket is left', async () => {
  mockDynamoFails = true;

  const response = await handler(request({ createBucket: true }));

  expect(response.statusCode).toBe(500);
  const names = mockS3Calls.map((c) => c.name);
  expect(names[0]).toBe('CreateBucketCommand');
  expect(names[names.length - 1]).toBe('DeleteBucketCommand');
});

test('createBucket with a bucketName is refused before any call', async () => {
  const response = await handler(request({ createBucket: true, bucketName: 'mine' }));

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error).toMatch(/bucketName must not be set/);
  expect(mockS3Calls).toHaveLength(0);
  expect(mockDynamoCalls).toHaveLength(0);
});

test('an existing bucket is still only checked and recorded, with no managedBucket flag', async () => {
  const response = await handler(request({ bucketName: 'somebody-elses-bucket' }));
  const body = JSON.parse(response.body);

  expect(response.statusCode).toBe(201);
  expect(body.data.managedBucket).toBeUndefined();
  expect(mockS3Calls.map((c) => c.name)).toEqual(['HeadBucketCommand', 'GetBucketLocationCommand']);
});
