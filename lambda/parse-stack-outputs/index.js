// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, DescribeInstancesCommand, CreateTagsCommand } = require('@aws-sdk/client-ec2');

/**
 * Parse CloudFormation Stack Outputs Lambda
 * 
 * This Lambda normalizes CloudFormation outputs into a consistent format
 * for storage in DynamoDB, regardless of storage type (fsx-windows, fsx-ontap, etc.)
 * 
 * Input: Step Functions state with stackStatus.Stacks[0].Outputs array and storageType
 * Output: Normalized object with named fields for DynamoDB update
 */

exports.handler = async (event) => {
  console.log('ParseStackOutputs received event:', JSON.stringify(event, null, 2));
  
  const { storageType, stackStatus, region, references } = event;
  const outputs = stackStatus?.Stacks?.[0]?.Outputs || [];
  
  // Convert outputs array to a map for easy lookup by OutputKey
  const outputMap = {};
  for (const output of outputs) {
    outputMap[output.OutputKey] = output.OutputValue;
  }
  
  console.log('Output map:', outputMap);
  
  // Build normalized result based on storage type
  let result = {};
  
  switch (storageType) {
    case 'fsx-windows':
      result = parseFsxWindowsOutputs(outputMap);
      break;
      
    case 'fsx-ontap':
      result = parseFsxOntapOutputs(outputMap);
      break;
      
    case 'storage-gateway':
      result = parseStorageGatewayOutputs(outputMap);
      break;

    case 'nexis':
      result = await parseNexisOutputs(outputMap, region, references);
      break;
      
    default:
      // Generic fallback - just pass through all outputs
      result = { outputs: outputMap };
      console.warn(`Unknown storage type: ${storageType}, using generic output parsing`);
  }
  
  console.log('Parsed result:', result);
  return result;
};

/**
 * Parse FSx for Windows File Server outputs
 */
function parseFsxWindowsOutputs(outputMap) {
  return {
    fsxFileSystemId: outputMap.FsxFileSystemId || 'N/A',
    fsxDnsName: outputMap.FsxDnsName || 'N/A',
    fsxResourceArn: outputMap.FsxResourceArn || 'N/A',
    // Placeholders so the shared UpdateStatusToAvailable state's JSONPath
    // references always resolve, regardless of which storage type ran.
    systemDirectorInstanceId: 'N/A',
    securityGroupSD: 'N/A',
    securityGroupClient: 'N/A',
    systemDirectorPrivateIp: 'N/A'
  };
}

/**
 * Parse FSx for NetApp ONTAP outputs
 * Note: DNS endpoints for SVM are not available as CloudFormation outputs.
 * They must be retrieved via FSx API (DescribeStorageVirtualMachines) after creation.
 */
function parseFsxOntapOutputs(outputMap) {
  return {
    fsxFileSystemId: outputMap.FileSystemId || 'N/A',
    fsxDnsName: 'N/A', // ONTAP doesn't expose DNS via CloudFormation - retrieved via API at mount time
    fsxResourceArn: outputMap.FileSystemArn || 'N/A',
    svmId: outputMap.SvmId || 'N/A',
    svmArn: outputMap.SvmArn || 'N/A',
    volumeId: outputMap.VolumeId || 'N/A',
    junctionPath: outputMap.JunctionPath || '/vol1',
    // Placeholders so the shared UpdateStatusToAvailable state's JSONPath
    // references always resolve, regardless of which storage type ran.
    systemDirectorInstanceId: 'N/A',
    securityGroupSD: 'N/A',
    securityGroupClient: 'N/A',
    systemDirectorPrivateIp: 'N/A'
  };
}

/**
 * Parse Avid NEXIS System Director outputs, including resolving the instance's
 * private IP (needed to point a NEXIS client's "remote hosts" entry at it). Unlike
 * ONTAP's SVM DNS (resolved separately at mount time since it can involve additional
 * setup), the System Director's IP is stable once created, so it's resolved once here.
 */
async function parseNexisOutputs(outputMap, region, references) {
  const instanceId = outputMap.SystemDirector;
  let privateIp = 'N/A';
  if (instanceId && instanceId !== 'N/A') {
    const ec2 = new EC2Client({ region: region || process.env.AWS_REGION });
    let instance;
    try {
      const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      instance = described.Reservations?.[0]?.Instances?.[0];
      privateIp = instance?.PrivateIpAddress || 'N/A';
    } catch (err) {
      console.error(`Failed to resolve private IP for System Director instance ${instanceId}:`, err);
    }
    if (instance) {
      await tagNexisVolumes(ec2, instance, references);
    }
  }
  return {
    systemDirectorInstanceId: instanceId || 'N/A',
    securityGroupSD: outputMap.SecurityGroupSD || 'N/A',
    securityGroupClient: outputMap.SecurityGroupClient || 'N/A',
    systemDirectorPrivateIp: privateIp,
    // Placeholders so the shared UpdateStatusToAvailable state's JSONPath
    // references always resolve, regardless of which storage type ran.
    fsxFileSystemId: 'N/A',
    fsxDnsName: 'N/A',
    fsxResourceArn: 'N/A'
  };
}

/**
 * Put the caller's ConstellationId and ProjectId on the System Director's EBS volumes.
 *
 * The stack tags reach the instance, but the volumes are made by Avid's nested ec2-sd.yaml, which
 * this repository does not hold, and CloudFormation does not carry stack tags onto volumes made
 * from an instance's block device mappings. The 632 GiB metadata volume alone is a billing line of
 * its own, so tagging stops short of the cost unless it reaches the disks. update-storage does the
 * same when a reference is set afterwards.
 *
 * Best effort: a tagging failure is logged and the stack's outputs are still returned, because the
 * storage exists and works either way.
 */
async function tagNexisVolumes(ec2, instance, references) {
  const tags = [
    ['constellationId', 'ConstellationId'],
    ['projectId', 'ProjectId']
  ]
    .filter(([field]) => references?.[field])
    .map(([field, Key]) => ({ Key, Value: String(references[field]) }));
  const volumeIds = (instance.BlockDeviceMappings || [])
    .map((mapping) => mapping.Ebs?.VolumeId)
    .filter(Boolean);
  if (tags.length === 0 || volumeIds.length === 0) return;
  try {
    await ec2.send(new CreateTagsCommand({ Resources: volumeIds, Tags: tags }));
  } catch (err) {
    console.error(`Failed to tag System Director volumes ${volumeIds.join(', ')}:`, err);
  }
}

/**
 * Parse Storage Gateway outputs (placeholder for future)
 */
function parseStorageGatewayOutputs(outputMap) {
  return {
    gatewayId: outputMap.GatewayId || 'N/A',
    gatewayArn: outputMap.GatewayArn || 'N/A',
    fileShareId: outputMap.FileShareId || 'N/A',
    fileShareArn: outputMap.FileShareArn || 'N/A'
  };
}
