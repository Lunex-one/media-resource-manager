// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Avid NEXIS Network Access Manager Lambda
 *
 * Reconciles a workstation's network interface security groups against its current
 * desired Avid NEXIS access. Unlike filesystem mounting, granting a workstation access
 * to a NEXIS System Director is purely a network change (membership in that System
 * Director's "client" security group) - there's no SSM command to run, no mount path,
 * and it works whether the workstation is running or stopped.
 *
 * Self-healing by design: rather than tracking what was previously granted, every
 * invocation re-derives the full desired state from the workstation's current
 * storageConfig and every known NEXIS storage's securityGroupClient, then reconciles
 * the instance's actual network interface to match - so it doesn't matter whether a
 * removed NEXIS assignment was deleted from storageConfig outright or just disabled.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, DescribeInstancesCommand, ModifyNetworkInterfaceAttributeCommand } = require('@aws-sdk/client-ec2');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

exports.handler = async (event) => {
  console.log('NexisNetworkAccessManager received event:', JSON.stringify(event, null, 2));

  const { action, instanceId } = event;
  if (action !== 'updateInstance') {
    return { success: true, skipped: true, reason: `Unhandled action: ${action}` };
  }

  try {
    await reconcileNexisAccess(instanceId);
    return { success: true };
  } catch (error) {
    console.error(`Failed to reconcile NEXIS network access for ${instanceId}:`, error);
    // Never throw - workstation-manager fires this asynchronously and doesn't check the
    // result, matching how the SMB/NFS mount manager failures are already handled.
    return { success: false, error: error.message };
  }
};

async function reconcileNexisAccess(instanceId) {
  const workstationResult = await dynamodb.send(new GetCommand({
    TableName: process.env.WORKSTATION_TABLE_NAME,
    Key: { instanceId }
  }));
  const workstation = workstationResult.Item;
  if (!workstation) {
    console.log(`Workstation ${instanceId} not found - skipping`);
    return;
  }

  const region = workstation.region || process.env.AWS_REGION;
  const ec2 = new EC2Client({ region });

  // Find every known NEXIS storage's client security group, regardless of region - a
  // workstation can only actually be granted access to one in its own VPC, but we need
  // the full set to correctly recognize (and remove) a stale NEXIS SG that's no longer
  // desired, even if this workstation's own storageConfig no longer mentions it at all.
  const allNexisSgs = await getAllNexisClientSecurityGroups();

  const storageConfig = workstation.storageConfig || {};
  const desiredStorageIds = Object.entries(storageConfig)
    .filter(([, cfg]) => cfg?.type === 'nexis' && cfg?.autoMount)
    .map(([storageId]) => storageId);
  const desiredSgs = new Set(
    desiredStorageIds
      .map((storageId) => allNexisSgs.storageIdToSg.get(storageId))
      .filter((sg) => sg && sg !== 'N/A')
  );

  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = described.Reservations?.[0]?.Instances?.[0];
  const eni = instance?.NetworkInterfaces?.[0];
  if (!eni) {
    console.log(`No network interface found for instance ${instanceId} - skipping`);
    return;
  }

  const currentSgIds = (eni.Groups || []).map((g) => g.GroupId);
  const knownNexisSgIds = new Set(allNexisSgs.sgToStorageId.keys());

  // Keep every SG that isn't a known NEXIS client SG, then add exactly the desired ones
  const newSgIds = currentSgIds.filter((id) => !knownNexisSgIds.has(id));
  for (const sg of desiredSgs) {
    if (!newSgIds.includes(sg)) newSgIds.push(sg);
  }

  const unchanged = newSgIds.length === currentSgIds.length
    && newSgIds.every((id) => currentSgIds.includes(id));
  if (unchanged) {
    console.log(`No NEXIS access changes needed for instance ${instanceId}`);
    return;
  }

  console.log(`Updating network interface ${eni.NetworkInterfaceId} security groups: ${JSON.stringify(currentSgIds)} -> ${JSON.stringify(newSgIds)}`);
  await ec2.send(new ModifyNetworkInterfaceAttributeCommand({
    NetworkInterfaceId: eni.NetworkInterfaceId,
    Groups: newSgIds,
  }));
}

async function getAllNexisClientSecurityGroups() {
  const storageIdToSg = new Map();
  const sgToStorageId = new Map();

  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: process.env.STORAGE_TABLE_NAME,
      FilterExpression: '#type = :nexis',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':nexis': 'nexis' },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    for (const item of result.Items || []) {
      if (item.securityGroupClient && item.securityGroupClient !== 'N/A') {
        storageIdToSg.set(item.storageId, item.securityGroupClient);
        sgToStorageId.set(item.securityGroupClient, item.storageId);
      }
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return { storageIdToSg, sgToStorageId };
}
