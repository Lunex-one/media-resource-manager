// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, CreateTagsCommand, DeleteTagsCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { FSxClient, TagResourceCommand, UntagResourceCommand } = require('@aws-sdk/client-fsx');
const { requireAdmin } = require('./authz');
const { tagChanges, tagTargets } = require('./reference-tags');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Carry a reference change onto the real AWS resources of a storage record.
 *
 * WHY THIS EXISTS. Until now this function wrote MRM's own record and stopped,
 * and the comment below the update said so: the same three references reach the
 * real resources as CloudFormation STACK tags, fixed when the stack was
 * created, "so a reference edited here is right in MRM and stale on the bill
 * for a resource that already exists".
 *
 * That is fine for a filesystem MRM created for a caller that already had its
 * references. It is not fine for an ADOPTED one -- a filesystem somebody made
 * by hand, which a caller later binds to one of its own resources. Binding
 * wrote MRM's record and nothing else, so the filesystem carried no
 * ConstellationId and no ProjectId, and every dollar it cost was unattributable
 * for ever. Nothing reported that; the record looked complete.
 *
 * TAGS ARE NOT RETROACTIVE ON A BILL. This makes an adopted filesystem
 * attributable from the bind onward and never for what it has already cost.
 * There is no way to fix the past here and none should be attempted.
 *
 * WHY NOT UpdateStack. The references are stack tags and a stack update would
 * be the tidy way to change them -- and would mean a CloudFormation update on a
 * live filesystem, with an FSx resource in it, to change a label. Tagging the
 * resources directly is what the workstation path already does
 * (workstation-manager's syncReferenceTags), and a directly-applied tag
 * survives alongside the stack's own.
 *
 * WHAT IT REACHES: the FSx file system by its recorded ARN, and a Nexis System
 * Director instance with every volume attached to it -- which is the same set
 * the workstation path covers, and for the same reason: a root volume is a
 * billing line of its own, so a reference that stops at the instance silently
 * misses the disk. A mountpoint-s3 record owns no AWS resource at all and is
 * correctly a no-op.
 *
 * It returns what it did rather than throwing. The caller records the outcome
 * on the item and reports it, which is the half the workstation path still gets
 * wrong: syncReferenceTags swallows its own failure with a console.warn, so a
 * bind can succeed in MRM while the tags never land and the only trace is a log
 * line in the payer's account.
 */
async function syncStorageReferenceTags(storage, changedFields) {
  const region = storage.region || process.env.AWS_REGION;
  const applied = [];

  const { setTags, clearKeys } = tagChanges(storage, changedFields);
  if (setTags.length === 0 && clearKeys.length === 0) {
    return { synced: [], skipped: 'no reference changed' };
  }

  const { fsxResourceArn, instanceId } = tagTargets(storage);

  // The FSx file system, by the ARN the state machine recorded.
  if (fsxResourceArn) {
    const fsx = new FSxClient({ region });
    if (setTags.length > 0) {
      await fsx.send(new TagResourceCommand({ ResourceARN: fsxResourceArn, Tags: setTags }));
    }
    if (clearKeys.length > 0) {
      await fsx.send(new UntagResourceCommand({ ResourceARN: fsxResourceArn, TagKeys: clearKeys }));
    }
    applied.push(fsxResourceArn);
  }

  // A Nexis System Director, and every volume attached to it.
  if (instanceId) {
    const ec2 = new EC2Client({ region });
    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const volumeIds = (described.Reservations?.[0]?.Instances?.[0]?.BlockDeviceMappings || [])
      .map((mapping) => mapping.Ebs?.VolumeId)
      .filter(Boolean);
    const resources = [instanceId, ...volumeIds];

    if (setTags.length > 0) {
      await ec2.send(new CreateTagsCommand({ Resources: resources, Tags: setTags }));
    }
    if (clearKeys.length > 0) {
      await ec2.send(new DeleteTagsCommand({ Resources: resources, Tags: clearKeys.map((Key) => ({ Key })) }));
    }
    applied.push(...resources);
  }

  return { synced: applied, region };
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'PUT,OPTIONS'
};

exports.handler = async (event) => {
  console.log('UpdateStorage event:', JSON.stringify(event, null, 2));
  
  // SECURITY: updating storage mutates the storage table (name, status,
  // configuration). Admin only. See H1-3966572 / GHSA-58q4-fcw9-2778 /
  // SIM P498186948.
  const denial = requireAdmin(event);
  if (denial) return denial;

  try {
    const storageId = event.pathParameters?.storageId;
    if (!storageId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Storage ID is required'
        })
      };
    }
    
    const data = JSON.parse(event.body || '{}');
    const updateExpression = [];
    const removeExpression = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    if (data.name) {
      updateExpression.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = data.name;
    }
    
    if (data.status) {
      updateExpression.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = data.status;
    }
    
    // The UI's edit form has always sent this alongside the name; nothing here read it until
    // 2026-08-31, so editing a description silently did nothing. Unlike the fields above, an empty
    // description is a real answer - "this resource has no description" - and create-storage
    // already stores '' for one, so it is set rather than removed.
    if (data.description !== undefined) {
      updateExpression.push('#description = :description');
      expressionAttributeNames['#description'] = 'description';
      expressionAttributeValues[':description'] = data.description;
    }
    
    if (data.configuration) {
      updateExpression.push('#configuration = :configuration');
      expressionAttributeNames['#configuration'] = 'configuration';
      expressionAttributeValues[':configuration'] = data.configuration;
    }
    
    // The three references, under the rule create-storage writes them by: a value sets the
    // attribute, an empty one removes it, so "nobody set this" stays distinguishable from "set to
    // nothing".
    //
    // This changes the record; syncStorageReferenceTags below carries the same change onto the
    // real AWS resources, which is what makes an ADOPTED filesystem attributable at all. It used
    // to stop here, and the comment in this place said why: the references reach the real
    // resources as CloudFormation stack tags fixed at create time, "so a reference edited here is
    // right in MRM and stale on the bill for a resource that already exists". True, and the cost
    // of it was that a filesystem somebody made by hand and bound afterwards carried neither
    // reference and could never be attributed to the project paying for it.
    const changedReferences = [];
    for (const field of ['constellationId', 'projectId', 'externalRef']) {
      if (data[field] === undefined) continue;
      changedReferences.push(field);
      if (data[field] === '' || data[field] === null) {
        removeExpression.push(`#${field}`);
        expressionAttributeNames[`#${field}`] = field;
      } else {
        updateExpression.push(`#${field} = :${field}`);
        expressionAttributeNames[`#${field}`] = field;
        expressionAttributeValues[`:${field}`] = data[field];
      }
    }
    
    if (updateExpression.length === 0 && removeExpression.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'No valid fields to update'
        })
      };
    }
    
    const clauses = [];
    if (updateExpression.length > 0) clauses.push(`SET ${updateExpression.join(', ')}`);
    if (removeExpression.length > 0) clauses.push(`REMOVE ${removeExpression.join(', ')}`);
    
    const updateParams = {
      TableName: process.env.STORAGE_TABLE_NAME,
      Key: { storageId },
      UpdateExpression: clauses.join(' '),
      ExpressionAttributeNames: expressionAttributeNames,
      ReturnValues: 'ALL_NEW'
    };
    // DynamoDB rejects an empty ExpressionAttributeValues, which a request that only clears
    // references would otherwise send.
    if (Object.keys(expressionAttributeValues).length > 0) {
      updateParams.ExpressionAttributeValues = expressionAttributeValues;
    }
    
    const result = await dynamodb.send(new UpdateCommand(updateParams));

    // Carry a reference change onto the real resources, and SAY WHETHER IT
    // WORKED. The record is already written at this point and the update
    // itself succeeded, so a tagging failure must not turn into a 500 that
    // makes a caller retry a write that already landed. But it must not vanish
    // either: a bind that reports success while the tags never arrive is a
    // filesystem that will be unattributable for the rest of its life, with
    // nothing anywhere saying so.
    //
    // So the outcome goes back in the response and onto the item, and a
    // failure is logged at error rather than as a warning. A caller that
    // cares -- constellation-supply's cost reader is the one that does -- can
    // see that the reference is in MRM and not on the bill.
    let referenceTags;
    if (changedReferences.length > 0) {
      try {
        referenceTags = {
          ok: true,
          ...(await syncStorageReferenceTags(result.Attributes, changedReferences))
        };
        console.log(`Reference tags synced for ${storageId}:`, JSON.stringify(referenceTags));
      } catch (error) {
        referenceTags = { ok: false, error: error.message };
        console.error(
          `Reference tags NOT applied for storage ${storageId}. The record is correct and the ` +
            `bill will not be: this resource is unattributable until the references are set again. `,
          error
        );
      }

      // Best effort, and deliberately not fatal: if THIS write fails the
      // response still carries the outcome, which is the part a caller reads.
      try {
        await dynamodb.send(new UpdateCommand({
          TableName: process.env.STORAGE_TABLE_NAME,
          Key: { storageId },
          UpdateExpression: 'SET referenceTagsSync = :sync',
          ExpressionAttributeValues: {
            ':sync': { ...referenceTags, at: new Date().toISOString() }
          }
        }));
      } catch (error) {
        console.error(`Could not record the reference-tag outcome on ${storageId}:`, error);
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: result.Attributes,
        ...(referenceTags ? { referenceTags } : {})
      })
    };
  } catch (error) {
    console.error('Error updating storage resource:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to update storage resource'
      })
    };
  }
};
