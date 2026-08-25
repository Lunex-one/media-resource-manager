// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('StorageConfig event:', JSON.stringify(event, null, 2));

  const path = event.path || event.resource || '';
  const qs = event.queryStringParameters || {};

  // Handle /storage/config endpoint - returns workstation role ARN for cross-account bucket policy
  if (path.endsWith('/config')) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        workstationRoleArn: process.env.WORKSTATION_ROLE_ARN,
        accountId: process.env.AWS_ACCOUNT_ID,
      })
    };
  }

  if (path.endsWith('/s3-buckets')) {
    const bucketName = qs.bucket;
    const action = qs.action;

    // --- Non-Cognito-Identity-Pool fallback actions (e.g. LDAP auth mode) ---
    // These use this Lambda's own IAM role for S3 access instead of federated browser credentials.
    // All dispatched via GET + ?action=... so no additional API Gateway methods are required.

    if (action === 'delete' && bucketName) {
      try {
        const key = qs.key;
        const keysParam = qs.keys; // comma-separated for batch delete of specific files
        if (keysParam) {
          const objects = keysParam.split(',').filter(Boolean).map((k) => ({ Key: k }));
          await s3Client.send(new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects }
          }));
        } else if (key && key.endsWith('/')) {
          // Folder delete: recursively list and batch-delete everything under this prefix
          let continuationToken;
          let deletedCount = 0;
          do {
            const listResult = await s3Client.send(new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: key,
              ContinuationToken: continuationToken
            }));
            const objectsToDelete = (listResult.Contents || [])
              .filter((o) => o.Key)
              .map((o) => ({ Key: o.Key }));
            if (objectsToDelete.length > 0) {
              await s3Client.send(new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: { Objects: objectsToDelete }
              }));
              deletedCount += objectsToDelete.length;
            }
            continuationToken = listResult.NextContinuationToken;
          } while (continuationToken);
          return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, deletedCount }) };
        } else if (key) {
          await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
        } else {
          return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Missing key or keys parameter' }) };
        }
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
      } catch (error) {
        console.error('Error deleting object(s):', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Failed to delete object(s)', details: error.message }) };
      }
    }

    if (action === 'createFolder' && bucketName) {
      try {
        let key = qs.key;
        if (!key) {
          return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Missing key parameter' }) };
        }
        if (!key.endsWith('/')) {
          key = key + '/';
        }
        await s3Client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: '' }));
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, key }) };
      } catch (error) {
        console.error('Error creating folder:', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Failed to create folder', details: error.message }) };
      }
    }

    if (action === 'download' && bucketName) {
      try {
        const key = qs.key;
        if (!key) {
          return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Missing key parameter' }) };
        }
        const url = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: bucketName, Key: key }),
          { expiresIn: 3600 }
        );
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ downloadUrl: url }) };
      } catch (error) {
        console.error('Error generating download URL:', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Failed to generate download URL', details: error.message }) };
      }
    }

    if (action === 'uploadUrl' && bucketName) {
      try {
        const key = qs.key;
        const contentType = qs.contentType || 'application/octet-stream';
        if (!key) {
          return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Missing key parameter' }) };
        }
        const url = await getSignedUrl(
          s3Client,
          new PutObjectCommand({ Bucket: bucketName, Key: key, ContentType: contentType }),
          { expiresIn: 3600 }
        );
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ uploadUrl: url }) };
      } catch (error) {
        console.error('Error generating upload URL:', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Failed to generate upload URL', details: error.message }) };
      }
    }

    // Handle /storage/s3-buckets?bucket=X&prefix=Y - list objects/folders inside a specific bucket
    if (bucketName) {
      try {
        const prefix = qs.prefix || '';
        const listResult = await s3Client.send(new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          Delimiter: '/'
        }));

        const folders = (listResult.CommonPrefixes || []).map((p) => ({
          key: p.Prefix,
          isFolder: true
        }));

        const files = (listResult.Contents || [])
          .filter((obj) => obj.Key !== prefix)
          .map((obj) => ({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString(),
            isFolder: false
          }));

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({ bucket: bucketName, prefix, folders, files })
        };
      } catch (error) {
        console.error('Error listing objects in bucket:', error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'Failed to list bucket objects',
            details: error.message
          })
        };
      }
    }

    // Handle /storage/s3-buckets endpoint (no bucket param) - list S3 buckets in the account
    try {
      const listResult = await s3Client.send(new ListBucketsCommand({}));
      const buckets = listResult.Buckets || [];
      console.log('Buckets found:', buckets.length);

      const bucketsWithLocation = await Promise.all(
        buckets.map(async (bucket) => {
          try {
            const locationResult = await s3Client.send(new GetBucketLocationCommand({
              Bucket: bucket.Name
            }));
            const region = locationResult.LocationConstraint || 'us-east-1';
            return {
              name: bucket.Name,
              arn: `arn:aws:s3:::${bucket.Name}`,
              region,
              creationDate: bucket.CreationDate?.toISOString()
            };
          } catch (error) {
            console.warn('Could not get location for bucket', bucket.Name + ':', error.message);
            return {
              name: bucket.Name,
              arn: `arn:aws:s3:::${bucket.Name}`,
              region: 'unknown',
              creationDate: bucket.CreationDate?.toISOString()
            };
          }
        })
      );

      const regionFilter = qs.region;
      const filteredBuckets = regionFilter
        ? bucketsWithLocation.filter(b => b.region === regionFilter)
        : bucketsWithLocation;

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(filteredBuckets)
      };
    } catch (error) {
      console.error('Error listing S3 buckets:', error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Failed to list S3 buckets',
          details: error.message
        })
      };
    }
  }

  // Unknown endpoint
  return {
    statusCode: 404,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Not found' })
  };
};
