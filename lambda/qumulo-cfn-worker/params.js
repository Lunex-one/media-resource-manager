// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * Pure helpers for deploying Cloud Native Qumulo (CNQ) from Qumulo's own CloudFormation
 * templates. Nothing here touches AWS, so test/qumulo-params.test.ts can assert exactly what
 * CloudFormation will be asked to create.
 *
 * Qumulo ships two stacks: a persistent-storage stack (the S3 buckets) and a compute stack
 * (the cluster nodes plus a Provisioner instance that forms the cluster). The compute stack
 * names the storage stack as a parameter, so the storage stack must exist first.
 */

const crypto = require('crypto');

// Where the operator staged Qumulo's templates inside the assets bucket (see scripts/stage-qumulo.sh).
const KEY_PREFIX = 'cnq/';
const STORAGE_TEMPLATE = 'persistent-storage.template.yaml';
// The advanced template is the only one that exposes QPermissionsBoundary to every role it
// creates; the standard template hard-codes it to an empty string.
const COMPUTE_TEMPLATE = 'cnq-advanced.template.yaml';

// Conservative first release. The template's own AllowedValues are the real list; extend this one
// after trying a size, not before.
const INSTANCE_TYPES = ['m6i.xlarge', 'i4i.2xlarge', 'i4i.4xlarge'];
const PERSISTENT_STORAGE_TYPES = ['hot_s3_std', 'hot_s3_int', 'cold_s3_ia', 'cold_s3_gir'];

const DEFAULTS = {
  instanceType: 'm6i.xlarge',
  nodeCount: 1,
  softCapacityTB: 50,
  persistentStorageType: 'hot_s3_std'
};

/**
 * Check and complete a Qumulo configuration. Returns { ok: true, value } or { ok: false, error }.
 */
function validateConfiguration(configuration) {
  const pick = (key) => configuration?.[key] ?? DEFAULTS[key];

  const instanceType = pick('instanceType');
  if (!INSTANCE_TYPES.includes(instanceType)) {
    return { ok: false, error: `Invalid instanceType for Qumulo: ${instanceType}. Must be one of: ${INSTANCE_TYPES.join(', ')}` };
  }

  const nodeCount = Number(pick('nodeCount'));
  const nodeCountOk = Number.isInteger(nodeCount) && (nodeCount === 1 || (nodeCount >= 3 && nodeCount <= 24));
  if (!nodeCountOk) {
    return { ok: false, error: 'Invalid nodeCount for Qumulo: must be 1, or a whole number from 3 to 24' };
  }

  const softCapacityTB = Number(pick('softCapacityTB'));
  if (!Number.isInteger(softCapacityTB) || softCapacityTB < 50 || softCapacityTB > 50000) {
    return { ok: false, error: 'Invalid softCapacityTB for Qumulo: must be a whole number from 50 to 50000' };
  }

  const persistentStorageType = pick('persistentStorageType');
  if (!PERSISTENT_STORAGE_TYPES.includes(persistentStorageType)) {
    return { ok: false, error: `Invalid persistentStorageType for Qumulo: ${persistentStorageType}. Must be one of: ${PERSISTENT_STORAGE_TYPES.join(', ')}` };
  }

  return { ok: true, value: { instanceType, nodeCount, softCapacityTB, persistentStorageType } };
}

function shortId(storageId) {
  return String(storageId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
}

/**
 * Both stack names start with `<acronym>-Qumulo-`. CloudFormation builds every role name from the
 * stack name, so that prefix is what lets the service role limit IAM writes to this storage type.
 */
function stackNames(acronym, storageId) {
  const base = `${acronym}-Qumulo-${shortId(storageId)}`;
  return { computeStackName: base, storageStackName: `${base}-Data` };
}

/**
 * Qumulo cluster names are 2-15 characters of letters, digits and hyphens, and must be unique.
 * A slice of the storage name keeps it recognisable; a slice of the storage ID keeps it unique.
 */
function clusterName(name, storageId) {
  const slug = String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 9) || 'qumulo';
  const suffix = shortId(storageId).slice(0, 5).toLowerCase();
  return `${slug}-${suffix}`.slice(0, 15);
}

/**
 * Qumulo's QClusterAdminPwd pattern: at least 8 characters from letters, digits and @$!%*?&-_,
 * with one lowercase, one uppercase and one special. Only `_` and `-` are used as specials, and a
 * password never starts with one, so it is safe to pass around in command lines.
 */
function generateAdminPassword() {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const special = '_-';
  const all = lower + upper + digits;
  const pickFrom = (set) => set[crypto.randomInt(set.length)];

  const chars = [pickFrom(lower), pickFrom(upper), pickFrom(special)];
  while (chars.length < 24) chars.push(pickFrom(all));

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const firstPlain = chars.findIndex((c) => /[A-Za-z0-9]/.test(c));
  [chars[0], chars[firstPlain]] = [chars[firstPlain], chars[0]];
  return chars.join('');
}

function templateUrl(bucket, region, file) {
  return `https://${bucket}.s3.${region}.amazonaws.com/${KEY_PREFIX}templates/${file}`;
}

const param = (ParameterKey, ParameterValue) => ({ ParameterKey, ParameterValue: String(ParameterValue) });

function buildStorageParameters({ bucket, region, boundaryPolicyName, softCapacityTB }) {
  return [
    param('QSS3BucketName', bucket),
    param('QSS3KeyPrefix', KEY_PREFIX),
    param('QSS3BucketRegion', region),
    param('QSoftCapacityLimit', softCapacityTB),
    // Protection stays on until MRM's own delete flow turns it off.
    param('QPersistentBucketProtect', 'YES'),
    param('QPermissionsBoundary', boundaryPolicyName)
  ];
}

function buildComputeParameters({
  bucket, region, keyName, network, storageStackName, clusterName: cluster,
  adminPassword, coreVersion, boundaryPolicyName, configuration
}) {
  return [
    param('QSS3BucketName', bucket),
    param('QSS3KeyPrefix', KEY_PREFIX),
    param('QSS3BucketRegion', region),
    param('EnvType', 'prod'),
    param('KeyPair', keyName),
    param('VPCId', network.vpcId),
    param('QSgCidr1', network.vpcCidr),
    // One availability zone. SecondPrivateSubnetID is required by the template even so, and must
    // be in a different zone.
    param('NumberAZs', 1),
    param('PrivateSubnetIDs', network.subnet1),
    param('SecondPrivateSubnetID', network.subnet2),
    // No load balancer, but the template still requires a value for its subnet list.
    param('QNlb', 'NO'),
    param('QNlbPrivateSubnetIDs', network.subnet1),
    param('QDebianPackage', 'DEB'),
    param('QPersistentStorageDeploymentStackName', storageStackName),
    param('QPersistentStorageType', configuration.persistentStorageType),
    param('QInstanceType', configuration.instanceType),
    param('QNodeCount', configuration.nodeCount),
    param('QMinFloatingIPperNode', 1),
    param('QReplacementCluster', 'NO'),
    param('QClusterVersion', coreVersion),
    param('QClusterName', cluster),
    param('QClusterAdminPwd', adminPassword),
    param('QAuditLog', 'NO'),
    param('TermProtection', 'YES'),
    param('QPermissionsBoundary', boundaryPolicyName)
  ];
}

/**
 * The compute stack's QumuloPrivateIP output is a URL such as https://10.0.138.96; a client needs
 * the bare address.
 */
function privateIpFromUrl(value) {
  if (!value) return 'N/A';
  try {
    return new URL(value).hostname || 'N/A';
  } catch (error) {
    return String(value);
  }
}

function outputsToMap(outputs) {
  return Object.fromEntries((outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

module.exports = {
  KEY_PREFIX,
  STORAGE_TEMPLATE,
  COMPUTE_TEMPLATE,
  INSTANCE_TYPES,
  PERSISTENT_STORAGE_TYPES,
  DEFAULTS,
  validateConfiguration,
  stackNames,
  clusterName,
  generateAdminPassword,
  templateUrl,
  buildStorageParameters,
  buildComputeParameters,
  outputsToMap,
  privateIpFromUrl
};
