// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NFS Mount Manager Lambda
 * 
 * Manages NFS mounts for FSx for NetApp ONTAP on Linux and macOS workstations.
 * Uses systemd on Linux and launchd on macOS for persistent mounts.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { FSxClient, DescribeStorageVirtualMachinesCommand } = require('@aws-sdk/client-fsx');
const { requireAdmin } = require('./authz');
const { UnsafeValueError } = require('./script-quote');
const scripts = require('./scripts');

// DynamoDB client for primary region (workstation table is in primary region)
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Cache for regional clients
const ec2Clients = {};
const ssmClients = {};
const fsxClients = {};

// Helper to get EC2 client for specific region
function getEC2Client(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!ec2Clients[targetRegion]) {
        ec2Clients[targetRegion] = new EC2Client({ region: targetRegion });
    }
    return ec2Clients[targetRegion];
}

// Helper to get SSM client for specific region
function getSSMClient(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!ssmClients[targetRegion]) {
        ssmClients[targetRegion] = new SSMClient({ region: targetRegion });
    }
    return ssmClients[targetRegion];
}

// Helper to get FSx client for specific region
function getFSxClient(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!fsxClients[targetRegion]) {
        fsxClients[targetRegion] = new FSxClient({ region: targetRegion });
    }
    return fsxClients[targetRegion];
}

const STORAGE_TABLE_NAME = process.env.STORAGE_TABLE_NAME;
const WORKSTATION_TABLE_NAME = process.env.WORKSTATION_TABLE_NAME;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
    console.log('NFS Mount Manager Event:', JSON.stringify(event, null, 2));

    // SECURITY: mount/unmount operations attach or detach an NFS export
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
            const body = JSON.parse(event.body);
            action = body.action;
            instanceId = body.instanceId;
            storageId = body.storageId;
        } else {
            action = event.action;
            instanceId = event.instanceId;
            storageId = event.storageId;
        }
        
        let result;
        switch (action) {
            case 'mount':
                result = await mountNfsStorage(instanceId, storageId);
                break;
            case 'unmount':
                result = await unmountNfsStorage(instanceId, storageId);
                break;
            case 'status':
                result = await checkMountStatus(instanceId, storageId);
                break;
            case 'updateInstance':
                result = await updateInstanceMounts(instanceId);
                break;
            default:
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ success: false, error: `Unknown action: ${action}` })
                };
        }
        
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };
        
    } catch (error) {
        console.error('Error in NFS Mount Manager:', error);
        // A storage record or mount path holding a value no script can carry safely is the
        // caller's to fix, not a fault here: answer 400 and send nothing to the workstation.
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
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};

/**
 * Update all NFS mounts for an instance based on its storageConfig
 * Called by workstation-manager when storage config changes
 */
async function updateInstanceMounts(instanceId) {
    console.log(`Updating NFS mounts for instance: ${instanceId}`);
    
    // Get workstation record
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        console.log(`Workstation not found: ${instanceId}`);
        return { success: false, message: 'Workstation not found', instanceId };
    }
    
    // Get workstation region
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    // Check platform - NFS mounts only work on Linux/macOS
    const platform = workstation.platform?.toLowerCase();
    if (platform !== 'linux' && platform !== 'macos') {
        console.log(`Skipping NFS mount for non-Linux/macOS workstation: ${instanceId} (platform: ${platform})`);
        return { 
            success: true, 
            message: `NFS mounts not supported on ${platform} workstations`, 
            instanceId,
            platform,
            skipped: true
        };
    }
    
    // Check if instance is running
    const ec2 = getEC2Client(workstationRegion);
    try {
        const instanceInfo = await ec2.send(new DescribeInstancesCommand({
            InstanceIds: [instanceId]
        }));
        const instance = instanceInfo.Reservations[0]?.Instances[0];
        if (!instance || instance.State.Name !== 'running') {
            console.log(`Instance ${instanceId} is not running, skipping mount`);
            return { 
                success: true, 
                message: 'Instance not running, mount will be applied when started', 
                instanceId,
                skipped: true
            };
        }
    } catch (error) {
        console.error(`Failed to check instance state: ${error.message}`);
        return { success: false, message: `Failed to check instance state: ${error.message}`, instanceId };
    }
    
    const storageConfig = workstation.storageConfig || {};
    const results = [];
    
    // Process each storage in the config
    for (const [storageId, config] of Object.entries(storageConfig)) {
        // Only process FSxN storage
        if (config.type !== 'fsx-ontap') {
            continue;
        }
        
        // Get storage to check region
        let storage;
        try {
            storage = await getStorageById(storageId);
        } catch (e) {
            console.error(`Failed to get storage ${storageId}: ${e.message}`);
            results.push({ storageId, action: 'skip', success: false, error: `Storage not found: ${storageId}` });
            continue;
        }
        
        // Check if storage is in the same region as workstation
        const storageRegion = storage?.region || process.env.AWS_REGION;
        if (storageRegion !== workstationRegion) {
            console.log(`Skipping storage ${storageId} - different region (storage: ${storageRegion}, workstation: ${workstationRegion})`);
            results.push({ 
                storageId, 
                action: 'skip', 
                success: false, 
                error: `Storage is in ${storageRegion}, workstation is in ${workstationRegion}. Cross-region mounts not supported.` 
            });
            continue;
        }
        
        if (config.autoMount) {
            try {
                console.log(`Mounting FSxN storage ${storageId} on ${instanceId}`);
                const result = await mountNfsStorage(instanceId, storageId);
                results.push({ storageId, action: 'mount', ...result });
            } catch (error) {
                console.error(`Failed to mount ${storageId}: ${error.message}`);
                results.push({ storageId, action: 'mount', success: false, error: error.message });
            }
        } else {
            // autoMount is disabled - unmount if currently mounted
            try {
                console.log(`Unmounting FSxN storage ${storageId} from ${instanceId} (autoMount disabled)`);
                const result = await unmountNfsStorage(instanceId, storageId);
                results.push({ storageId, action: 'unmount', ...result });
            } catch (error) {
                // Don't fail if unmount fails (might not be mounted)
                console.log(`Unmount ${storageId} skipped or failed: ${error.message}`);
                results.push({ storageId, action: 'unmount', skipped: true, message: error.message });
            }
        }
    }
    
    return {
        success: true,
        message: `Processed ${results.length} FSxN storage operations`,
        instanceId,
        platform,
        region: workstationRegion,
        results
    };
}


/**
 * Mount FSxN storage via NFS on a Linux or macOS workstation
 */
async function mountNfsStorage(instanceId, storageId) {
    console.log(`Mounting NFS storage ${storageId} on instance ${instanceId}`);
    
    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    if (storage.type !== 'fsx-ontap') {
        throw new Error(`Storage ${storageId} is not FSx for NetApp ONTAP type`);
    }
    
    // Get workstation to verify platform and get region
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    const storageRegion = storage.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}, Storage ${storageId} is in region: ${storageRegion}`);
    
    // Validate regions match - FSx storage can only be mounted from the same region
    if (workstationRegion !== storageRegion) {
        throw new Error(`Cannot mount storage from different region. Workstation is in ${workstationRegion}, but storage is in ${storageRegion}. FSx storage can only be mounted from workstations in the same region.`);
    }
    
    const platform = workstation.platform?.toLowerCase();
    if (platform !== 'linux' && platform !== 'macos') {
        throw new Error(`NFS mounts only supported on Linux and macOS. Instance ${instanceId} is ${platform}`);
    }
    
    // Use regional EC2 client
    const ec2 = getEC2Client(workstationRegion);
    
    // Verify instance is running
    const instanceInfo = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    }));
    
    const instance = instanceInfo.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
        throw new Error(`Instance ${instanceId} is not running`);
    }
    
    // Get SVM NFS endpoint using regional FSx client
    const fsx = getFSxClient(workstationRegion);
    let nfsEndpoint = null;
    
    // Parse parsedOutputs if it's a JSON string (contains svmId, junctionPath, etc.)
    let parsedOutputs = {};
    if (storage.parsedOutputs) {
        try {
            parsedOutputs = typeof storage.parsedOutputs === 'string' 
                ? JSON.parse(storage.parsedOutputs) 
                : storage.parsedOutputs;
        } catch (e) {
            console.warn('Failed to parse parsedOutputs for storage', storageId + ':', e);
        }
    }
    
    // Get svmId from parsedOutputs or top-level field
    const svmId = storage.svmId || parsedOutputs.svmId;
    
    if (svmId) {
        try {
            const svmResponse = await fsx.send(new DescribeStorageVirtualMachinesCommand({
                StorageVirtualMachineIds: [svmId]
            }));
            const svm = svmResponse.StorageVirtualMachines?.[0];
            if (svm?.Endpoints?.Nfs?.DNSName) {
                nfsEndpoint = svm.Endpoints.Nfs.DNSName;
            }
            console.log(`SVM ${svmId} NFS endpoint: ${nfsEndpoint}`);
        } catch (error) {
            console.error('Failed to get SVM NFS endpoint for', svmId + ':', error);
        }
    }
    
    if (!nfsEndpoint) {
        throw new Error(`Could not determine NFS endpoint for storage ${storageId}`);
    }
    
    const junctionPath = storage.junctionPath || parsedOutputs.junctionPath || '/vol1';
    // Use platform-appropriate mount path: /Volumes for macOS, /mnt for Linux
    const defaultMountPath = platform === 'macos' 
        ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
        : `/mnt/fsxn-${storageId.substring(0, 8)}`;
    const mountPath = workstation.storageConfig?.[storageId]?.mountPath || defaultMountPath;
    const serviceName = scripts.serviceNameFor(storageId);
    
    // Generate and execute mount script based on platform
    let script;
    if (platform === 'linux') {
        script = scripts.generateLinuxNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName);
    } else {
        script = scripts.generateMacOsNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName);
    }
    
    // Execute via SSM using regional client
    const ssm = getSSMClient(workstationRegion);
    const documentName = platform === 'linux' ? 'AWS-RunShellScript' : 'AWS-RunShellScript';
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: `Mount FSxN NFS ${storage.name} at ${mountPath}`
    }));
    
    console.log(`SSM command sent to ${workstationRegion}: ${commandResult.Command.CommandId}`);
    
    // Wait for command to complete
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 120, workstationRegion);
    
    if (result.Status === 'Success') {
        console.log(`Successfully mounted NFS storage ${storageId} on ${instanceId}`);
        return {
            success: true,
            message: `FSxN volume mounted at ${mountPath}`,
            instanceId,
            storageId,
            mountPath,
            nfsEndpoint,
            junctionPath,
            region: workstationRegion
        };
    } else {
        console.error(`Failed to mount NFS storage: ${result.StandardErrorContent}`);
        throw new Error(`Mount failed: ${result.StandardErrorContent || result.Status}`);
    }
}

/**
 * Unmount NFS storage from a workstation
 */
async function unmountNfsStorage(instanceId, storageId) {
    console.log(`Unmounting NFS storage ${storageId} from instance ${instanceId}`);
    
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    const platform = workstation.platform?.toLowerCase();
    // Use platform-appropriate mount path: /Volumes for macOS, /mnt for Linux
    const defaultMountPath = platform === 'macos' 
        ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
        : `/mnt/fsxn-${storageId.substring(0, 8)}`;
    const mountPath = workstation.storageConfig?.[storageId]?.mountPath || defaultMountPath;
    const serviceName = scripts.serviceNameFor(storageId);
    
    let script;
    if (platform === 'linux') {
        script = scripts.generateLinuxNfsUnmountScript(mountPath, serviceName);
    } else if (platform === 'macos') {
        script = scripts.generateMacOsNfsUnmountScript(mountPath, serviceName);
    } else {
        throw new Error(`NFS unmount not supported on ${platform}`);
    }
    
    // Use regional SSM client
    const ssm = getSSMClient(workstationRegion);
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: `Unmount FSxN NFS ${storageId}`
    }));
    
    console.log(`SSM command sent to ${workstationRegion}: ${commandResult.Command.CommandId}`);
    
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 60, workstationRegion);
    
    if (result.Status === 'Success') {
        return {
            success: true,
            message: `NFS storage unmounted from ${mountPath}`,
            instanceId,
            storageId,
            region: workstationRegion
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
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    const platform = workstation.platform?.toLowerCase();
    // Use platform-appropriate mount path: /Volumes for macOS, /mnt for Linux
    const defaultMountPath = platform === 'macos' 
        ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
        : `/mnt/fsxn-${storageId.substring(0, 8)}`;
    const mountPath = workstation.storageConfig?.[storageId]?.mountPath || defaultMountPath;
    
    let script;
    if (platform === 'linux') {
        script = scripts.generateLinuxStatusScript(mountPath);
    } else if (platform === 'macos') {
        script = scripts.generateMacOsStatusScript(mountPath);
    } else {
        throw new Error(`Mount status check not supported on ${platform}`);
    }
    
    // Use regional SSM client
    const ssm = getSSMClient(workstationRegion);
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: `Check NFS mount status for ${storageId}`
    }));
    
    console.log(`SSM command sent to ${workstationRegion}: ${commandResult.Command.CommandId}`);
    
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 30, workstationRegion);
    
    const output = result.StandardOutputContent || '';
    const isMounted = output.includes('MOUNTED') && !output.includes('NOT_MOUNTED');
    
    return {
        success: true,
        instanceId,
        storageId,
        mounted: isMounted,
        mountPath,
        region: workstationRegion
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
async function waitForCommand(commandId, instanceId, timeoutSeconds = 120, region = null) {
    const ssm = getSSMClient(region);
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
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            if (error.name === 'InvocationDoesNotExist') {
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Command ${commandId} timed out after ${timeoutSeconds} seconds`);
}
