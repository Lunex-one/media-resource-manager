// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * Qumulo CloudFormation Worker Lambda
 *
 * Deploys Cloud Native Qumulo from Qumulo's own templates (staged in the assets bucket) and is
 * called by the Qumulo creation and deletion state machines. It is deliberately separate from
 * storage-cfn-worker: Qumulo's stacks create IAM roles, Lambdas, KMS grants and 38 nested stacks,
 * so they run under a dedicated CloudFormation service role (SERVICE_ROLE_ARN) instead of this
 * function's own identity. This function itself can only manage stacks, pass that one role, read
 * the staged templates, read its network and version parameters, and keep one secret per storage.
 *
 * Actions:
 * - createStack:        kind 'storage' (persistent buckets) or 'compute' (cluster nodes)
 * - describeStacks:     status plus a map of the stack's outputs (for polling)
 * - disableProtection:  turn off termination protection and bucket protection before a delete
 * - deleteStack:        delete one stack
 */

const {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
  UpdateStackCommand,
  UpdateTerminationProtectionCommand
} = require('@aws-sdk/client-cloudformation');
const { SSMClient, GetParameterCommand, GetParametersCommand } = require('@aws-sdk/client-ssm');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand
} = require('@aws-sdk/client-secrets-manager');
const qumulo = require('./params');

const region = process.env.AWS_REGION;
const cfn = new CloudFormationClient({ region });
const ssm = new SSMClient({ region });
const secrets = new SecretsManagerClient({ region });

const CAPABILITIES = ['CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND'];
const UPDATABLE_STATUSES = ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'];

const productName = () => process.env.PRODUCT_NAME || 'MediaResourceManager';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

const isMissingStack = (error) =>
  error.name === 'ValidationError' && /does not exist/.test(error.message || '');

/**
 * The caller's references as stack tags, dropping empties. Same keys as storage-cfn-worker, so
 * per-project cost queries group Qumulo storage with every other storage type.
 */
function referenceTags(references) {
  const keys = { constellationId: 'ConstellationId', projectId: 'ProjectId', externalRef: 'ExternalRef' };
  return Object.entries(keys)
    .filter(([field]) => references?.[field])
    .map(([field, Key]) => ({ Key, Value: String(references[field]) }));
}

/**
 * Stack tags. MrmStorageType=qumulo is what the permissions boundary keys on: it only lets
 * ssm:SendCommand and instance attribute changes reach instances carrying it. CloudFormation
 * copies stack tags onto the nested stacks and the instances they create.
 */
function stackTags(references) {
  return [
    { Key: 'ManagedBy', Value: productName() },
    { Key: 'CreatedBy', Value: 'QumuloStateMachine' },
    { Key: 'Region', Value: region },
    { Key: 'MrmStorageType', Value: 'qumulo' },
    ...referenceTags(references)
  ];
}

async function getNetwork() {
  const keys = {
    vpcId: 'VpcId',
    vpcCidr: 'VpcCidr',
    subnet1: 'PrivateSubnet1/SubnetID',
    subnet2: 'PrivateSubnet2/SubnetID'
  };
  const nameOf = (key) => `/${productName()}/Network/${key}`;
  const response = await ssm.send(new GetParametersCommand({ Names: Object.values(keys).map(nameOf) }));
  const byName = Object.fromEntries((response.Parameters || []).map((p) => [p.Name, p.Value]));
  const network = {};
  for (const [field, key] of Object.entries(keys)) {
    if (!byName[nameOf(key)]) throw new Error(`Network parameter ${nameOf(key)} is missing`);
    network[field] = byName[nameOf(key)];
  }
  return network;
}

async function getCoreVersion() {
  const name = `/${productName()}/Qumulo/CoreVersion`;
  let version;
  try {
    const response = await ssm.send(new GetParameterCommand({ Name: name }));
    version = response.Parameter.Value;
  } catch (error) {
    if (error.name === 'ParameterNotFound') {
      throw new Error(`Qumulo is not staged: SSM parameter ${name} does not exist. Run scripts/stage-qumulo.sh first.`);
    }
    throw error;
  }
  if (!version || version.length > 11) {
    throw new Error(`SSM parameter ${name} must hold the Qumulo Core version (11 characters at most)`);
  }
  return version;
}

/**
 * The cluster admin password lives in Secrets Manager at the same path style as NEXIS's. It is
 * created once and read back here, so the value is never part of a Step Functions input or output.
 */
async function ensureAdminPassword(storageId, references) {
  const SecretId = `/${productName()}/Storage/${storageId}/QumuloAdminPassword`;
  try {
    const existing = await secrets.send(new GetSecretValueCommand({ SecretId }));
    return JSON.parse(existing.SecretString).password;
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
  }
  const password = qumulo.generateAdminPassword();
  await secrets.send(new CreateSecretCommand({
    Name: SecretId,
    SecretString: JSON.stringify({ username: 'admin', password }),
    Tags: [{ Key: 'ManagedBy', Value: productName() }, ...referenceTags(references)]
  }));
  return password;
}

async function createStack(event) {
  const { kind, stackName, storageId, name, references } = event;
  if (!stackName) throw new Error('Missing required parameter: stackName');

  const checked = qumulo.validateConfiguration(event.configuration);
  if (!checked.ok) throw new Error(checked.error);
  const configuration = checked.value;

  const bucket = required('ASSETS_BUCKET');
  const boundaryPolicyName = required('BOUNDARY_POLICY_NAME');

  let templateFile;
  let parameters;
  if (kind === 'storage') {
    templateFile = qumulo.STORAGE_TEMPLATE;
    parameters = qumulo.buildStorageParameters({
      bucket, region, boundaryPolicyName, softCapacityTB: configuration.softCapacityTB
    });
  } else if (kind === 'compute') {
    if (!event.storageStackName) throw new Error('Missing required parameter: storageStackName');
    if (!storageId) throw new Error('Missing required parameter: storageId');
    templateFile = qumulo.COMPUTE_TEMPLATE;
    const [network, coreVersion, adminPassword] = await Promise.all([
      getNetwork(),
      getCoreVersion(),
      ensureAdminPassword(storageId, references)
    ]);
    parameters = qumulo.buildComputeParameters({
      bucket,
      region,
      keyName: required('KEY_NAME'),
      network,
      storageStackName: event.storageStackName,
      clusterName: qumulo.clusterName(name, storageId),
      adminPassword,
      coreVersion,
      boundaryPolicyName,
      configuration
    });
  } else {
    throw new Error(`Unknown stack kind: ${kind}`);
  }

  const result = await cfn.send(new CreateStackCommand({
    StackName: stackName,
    TemplateURL: qumulo.templateUrl(bucket, region, templateFile),
    Parameters: parameters,
    Capabilities: CAPABILITIES,
    RoleARN: required('SERVICE_ROLE_ARN'),
    Tags: stackTags(references),
    // Keep a failed stack so its events can be read; MRM's delete flow cleans it up.
    OnFailure: 'DO_NOTHING'
  }));
  console.log(`Stack creation initiated: ${result.StackId}`);
  return { stackId: result.StackId, stackName, region, status: 'CREATE_IN_PROGRESS' };
}

async function describeStacks(event) {
  try {
    const result = await cfn.send(new DescribeStacksCommand({ StackName: event.stackName }));
    const stack = result.Stacks?.[0];
    if (!stack) throw new Error(`Stack not found: ${event.stackName}`);
    return {
      Stacks: [{
        StackName: stack.StackName,
        StackId: stack.StackId,
        StackStatus: stack.StackStatus,
        StackStatusReason: stack.StackStatusReason || ''
      }],
      outputs: qumulo.outputsToMap(stack.Outputs),
      // Always present, so the state machine's JSONPath references resolve for either stack.
      qumuloUrl: qumulo.outputsToMap(stack.Outputs).QumuloPrivateIP || 'N/A',
      qumuloPrivateIp: qumulo.privateIpFromUrl(qumulo.outputsToMap(stack.Outputs).QumuloPrivateIP),
      region
    };
  } catch (error) {
    if (isMissingStack(error)) {
      return {
        Stacks: [{ StackName: event.stackName, StackStatus: 'DELETE_COMPLETE', StackStatusReason: 'Stack does not exist' }],
        outputs: {},
        qumuloUrl: 'N/A',
        qumuloPrivateIp: 'N/A',
        region
      };
    }
    throw error;
  }
}

/**
 * Qumulo turns termination protection on for the stacks it deploys, and protects the persistent
 * buckets with QPersistentBucketProtect. Both have to go before a delete can succeed.
 * Returns { status } where UPDATE_IN_PROGRESS means the caller must wait for the storage stack
 * to reach UPDATE_COMPLETE, and NO_UPDATE means there is nothing to wait for.
 */
async function disableProtection(event) {
  const { storageStackName, computeStackName } = event;
  if (!storageStackName || !computeStackName) {
    throw new Error('Missing required parameter: storageStackName and computeStackName');
  }

  for (const StackName of [computeStackName, storageStackName]) {
    try {
      await cfn.send(new UpdateTerminationProtectionCommand({ StackName, EnableTerminationProtection: false }));
    } catch (error) {
      if (!isMissingStack(error)) throw error;
    }
  }

  let stack;
  try {
    const described = await cfn.send(new DescribeStacksCommand({ StackName: storageStackName }));
    stack = described.Stacks?.[0];
  } catch (error) {
    if (isMissingStack(error)) return { status: 'NO_UPDATE', region };
    throw error;
  }
  if (!stack || !UPDATABLE_STATUSES.includes(stack.StackStatus)) return { status: 'NO_UPDATE', region };

  const protect = (stack.Parameters || []).find((p) => p.ParameterKey === 'QPersistentBucketProtect');
  if (!protect || protect.ParameterValue === 'NO') return { status: 'NO_UPDATE', region };

  try {
    await cfn.send(new UpdateStackCommand({
      StackName: storageStackName,
      UsePreviousTemplate: true,
      Parameters: stack.Parameters.map((p) =>
        p.ParameterKey === 'QPersistentBucketProtect'
          ? { ParameterKey: p.ParameterKey, ParameterValue: 'NO' }
          : { ParameterKey: p.ParameterKey, UsePreviousValue: true }),
      Capabilities: CAPABILITIES,
      RoleARN: required('SERVICE_ROLE_ARN')
    }));
  } catch (error) {
    if (/No updates are to be performed/.test(error.message || '')) return { status: 'NO_UPDATE', region };
    throw error;
  }
  return { status: 'UPDATE_IN_PROGRESS', region };
}

async function deleteStack(event) {
  try {
    await cfn.send(new DeleteStackCommand({ StackName: event.stackName, RoleARN: required('SERVICE_ROLE_ARN') }));
    return { stackName: event.stackName, region, status: 'DELETE_IN_PROGRESS' };
  } catch (error) {
    if (isMissingStack(error)) return { stackName: event.stackName, region, status: 'DELETE_COMPLETE' };
    throw error;
  }
}

exports.handler = async (event) => {
  // Never log the whole event for createStack callers that might one day carry secrets.
  console.log('QumuloCfnWorker action:', event.action, 'stack:', event.stackName || event.computeStackName);

  switch (event.action) {
    case 'createStack': return createStack(event);
    case 'describeStacks': return describeStacks(event);
    case 'disableProtection': return disableProtection(event);
    case 'deleteStack': return deleteStack(event);
    default: throw new Error(`Unknown action: ${event.action}`);
  }
};
