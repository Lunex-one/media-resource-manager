// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 Mount Manager Lambda
 * 
 * Manages Mountpoint for Amazon S3 on Linux workstations.
 * Handles installation, mounting via systemd, and unmounting.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { S3Client, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
const { requireAdmin } = require('./authz');
const { UnsafeValueError } = require('./script-quote');
const scripts = require('./scripts');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Workstations in a Regional Hub live outside this Lambda's home region -
// EC2/SSM clients must be scoped per-request to the workstation's actual region.
function getSsmClient(region) {
    return new SSMClient({ region: region || process.env.AWS_REGION });
}
function getEc2Client(region) {
    return new EC2Client({ region: region || process.env.AWS_REGION });
}

const STORAGE_TABLE_NAME = process.env.STORAGE_TABLE_NAME;
const WORKSTATION_TABLE_NAME = process.env.WORKSTATION_TABLE_NAME;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
    console.log('S3 Mount Manager Event:', JSON.stringify(event, null, 2));

    // SECURITY: mount/unmount operations attach or detach a storage volume
    // from another user's workstation. Gate API Gateway invocations on
    // admin. Direct Lambda invocations from workstation-manager (which have
    // no authorizer context) are trusted internal callers.
    // See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948.
    if (event.requestContext?.authorizer) {
        const denial = requireAdmin(event);
        if (denial) return denial;
    }

    try {
        // Handle API Gateway event format
        let action, instanceId, storageId;
        
        if (event.body) {
            // API Gateway request
            const body = JSON.parse(event.body);
            action = body.action;
            instanceId = body.instanceId;
            storageId = body.storageId;
        } else {
            // Direct invocation
            action = event.action;
            instanceId = event.instanceId;
            storageId = event.storageId;
        }
        
        let result;
        switch (action) {
            case 'mount':
                result = await mountS3Storage(instanceId, storageId);
                break;
            case 'unmount':
                result = await unmountS3Storage(instanceId, storageId);
                break;
            case 'status':
                result = await checkMountStatus(instanceId, storageId);
                break;
            default:
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ success: false, error: `Unknown action: ${action}` })
                };
        }
        
        // Return API Gateway formatted response
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };
        
    } catch (error) {
        console.error('Error in S3 Mount Manager:', error);
        // A storage record holding a value no script can carry safely is the caller's to fix,
        // not a fault here: answer 400 and send nothing to the workstation.
        if (error instanceof UnsafeValueError) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ success: false, error: error.message })
            };
        }
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                success: false, 
                error: error.message 
            })
        };
    }
};


/**
 * Mount S3 bucket on a workstation using Mountpoint for S3 (Linux) or rclone+WinFsp (Windows)
 */
async function mountS3Storage(instanceId, storageId) {
    console.log(`Mounting S3 storage ${storageId} on instance ${instanceId}`);

    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }

    if (storage.type !== 'mountpoint-s3') {
        throw new Error(`Storage ${storageId} is not a Mountpoint for S3 type`);
    }

    // Get workstation to determine platform
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }

    const platform = workstation.platform?.toLowerCase();
    if (platform !== 'linux' && platform !== 'windows') {
        throw new Error(`S3 mounting only supports Linux and Windows workstations. Instance ${instanceId} is ${workstation.platform}`);
    }

    // Workstations in a Regional Hub live outside this Lambda's home region -
    // EC2/SSM clients must be scoped to the workstation's actual region.
    const region = workstation.region || process.env.AWS_REGION;
    const ec2 = getEc2Client(region);
    const ssm = getSsmClient(region);

    // Verify instance is running
    const instanceInfo = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    }));

    const instance = instanceInfo.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
        throw new Error(`Instance ${instanceId} is not running`);
    }

    // Generate service/task name (sanitized)
    const serviceName = scripts.serviceNameFor(storageId);

    // storage.region only records where the storage config was created (always the
    // Lambda's home region), not where the bucket actually lives - rclone (unlike Linux's
    // Mountpoint-S3) needs the real bucket region for S3 v4 signing, so resolve it directly.
    let mountStorage = storage;
    if (platform === 'windows') {
        try {
            const s3 = new S3Client({ region: process.env.AWS_REGION });
            const loc = await s3.send(new GetBucketLocationCommand({ Bucket: storage.bucketName }));
            mountStorage = { ...storage, region: loc.LocationConstraint || 'us-east-1' };
        } catch (err) {
            console.error(`Failed to resolve bucket region for ${storage.bucketName}, falling back to stored region:`, err);
        }
    }

    // Generate the installation and mount script, and pick the right SSM document per platform
    const script = platform === 'windows'
        ? scripts.generateWindowsMountScript(mountStorage, serviceName)
        : scripts.generateMountScript(storage, serviceName);
    const documentName = platform === 'windows' ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript';

    // Execute via SSM (comment limited to 100 chars)
    const comment = `Mount S3 ${storage.bucketName.substring(0, 40)} - ${storageId.substring(0, 8)}`;
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: comment
    }));

    console.log(`SSM command sent: ${commandResult.Command.CommandId}`);

    // Wait for command to complete (with timeout)
    const result = await waitForCommand(ssm, commandResult.Command.CommandId, instanceId, 120);

    if (result.Status === 'Success') {
        console.log(`Successfully mounted S3 storage ${storageId} on ${instanceId}`);
        return {
            success: true,
            message: `S3 bucket ${storage.bucketName} mounted at ${storage.mountPath}`,
            instanceId,
            storageId,
            mountPath: storage.mountPath
        };
    } else {
        console.error(`Failed to mount S3 storage: ${result.StandardErrorContent}`);
        throw new Error(`Mount failed: ${result.StandardErrorContent || result.Status}`);
    }
}


/**
 * Unmount S3 bucket from a workstation
 */
async function unmountS3Storage(instanceId, storageId) {
    console.log(`Unmounting S3 storage ${storageId} from instance ${instanceId}`);

    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }

    const workstation = await getWorkstationById(instanceId);
    const platform = workstation?.platform?.toLowerCase();
    const region = workstation?.region || process.env.AWS_REGION;
    const ssm = getSsmClient(region);

    // Generate service/task name (sanitized)
    const serviceName = scripts.serviceNameFor(storageId);

    let script;
    let documentName;

    if (platform === 'windows') {
        documentName = 'AWS-RunPowerShellScript';
        script = scripts.generateWindowsUnmountScript(storage, serviceName);
    } else {
        documentName = 'AWS-RunShellScript';
        script = scripts.generateUnmountScript(storage, serviceName);
    }

    // Execute via SSM
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: `Unmount S3 storage ${storageId}`
    }));

    const result = await waitForCommand(ssm, commandResult.Command.CommandId, instanceId, 60);

    if (result.Status === 'Success') {
        return {
            success: true,
            message: `S3 storage unmounted from ${storage.mountPath}`,
            instanceId,
            storageId
        };
    } else {
        throw new Error(`Unmount failed: ${result.StandardErrorContent || result.Status}`);
    }
}


/**
 * Check mount status on a workstation
 */
async function checkMountStatus(instanceId, storageId) {
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }

    const workstation = await getWorkstationById(instanceId);
    const platform = workstation?.platform?.toLowerCase();
    const region = workstation?.region || process.env.AWS_REGION;
    const ssm = getSsmClient(region);

    const serviceName = scripts.serviceNameFor(storageId);

    let script;
    let documentName;

    if (platform === 'windows') {
        documentName = 'AWS-RunPowerShellScript';
        script = scripts.generateWindowsStatusScript(storage, serviceName);
    } else {
        documentName = 'AWS-RunShellScript';
        script = scripts.generateStatusScript(storage, serviceName);
    }

    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: `Check S3 mount status for ${storageId}`
    }));

    const result = await waitForCommand(ssm, commandResult.Command.CommandId, instanceId, 30);

    const output = result.StandardOutputContent || '';
    const isMounted = output.includes('MOUNTED') && !output.includes('NOT_MOUNTED');
    const serviceActive = output.includes('SERVICE_ACTIVE');

    return {
        success: true,
        instanceId,
        storageId,
        mounted: isMounted,
        serviceActive,
        mountPath: storage.mountPath
    };
}



/**
 * Get storage configuration by ID
 */
async function getStorageById(storageId) {
    const result = await dynamodb.send(new GetCommand({
        TableName: STORAGE_TABLE_NAME,
        Key: { storageId }
    }));
    return result.Item;
}

/**
 * Get workstation by instance ID
 */
async function getWorkstationById(instanceId) {
    const result = await dynamodb.send(new GetCommand({
        TableName: WORKSTATION_TABLE_NAME,
        Key: { instanceId }
    }));
    return result.Item;
}

/**
 * Wait for SSM command to complete
 */
async function waitForCommand(ssm, commandId, instanceId, timeoutSeconds = 120) {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const result = await ssm.send(new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: instanceId
            }));
            
            if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(result.Status)) {
                return result;
            }
            
            // Wait before polling again
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            if (error.name === 'InvocationDoesNotExist') {
                // Command not yet registered, wait and retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Command ${commandId} timed out after ${timeoutSeconds} seconds`);
}
