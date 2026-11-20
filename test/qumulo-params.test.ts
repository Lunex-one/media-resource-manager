// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What MRM asks CloudFormation to build when someone creates Qumulo storage.
 *
 * Qumulo's templates reject a bad parameter late (a failed stack, 20 minutes in) or, worse,
 * accept it and build something we did not mean. These tests pin the decisions that are ours:
 * which sizes are allowed, how stacks and the cluster are named, that the permissions boundary
 * and protections are always on, and that the admin password satisfies Qumulo's own pattern.
 */

const q = require('../lambda/qumulo-cfn-worker/params.js');

// Copied from QClusterAdminPwd in cnq-advanced.template.yaml.
const QUMULO_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[@$!%*?&\-_])[A-Za-z\d@$!%*?&\-_]{8,}$/;
const STORAGE_ID = '3f9a1c2e-7b44-4d6a-9d2f-0123456789ab';

const asMap = (list: Array<{ ParameterKey: string; ParameterValue: string }>) =>
  Object.fromEntries(list.map((p) => [p.ParameterKey, p.ParameterValue]));

describe('validateConfiguration', () => {
  it('fills in a small test deployment when nothing is given', () => {
    expect(q.validateConfiguration({})).toEqual({
      ok: true,
      value: { instanceType: 'm6i.xlarge', nodeCount: 1, softCapacityTB: 50, persistentStorageType: 'hot_s3_std' }
    });
  });

  it('accepts a missing configuration', () => {
    expect(q.validateConfiguration(undefined).ok).toBe(true);
  });

  it('rejects an instance type that is not on the list', () => {
    expect(q.validateConfiguration({ instanceType: 't3.micro' }).ok).toBe(false);
  });

  it.each([2, 25, 0, 1.5])('rejects %p nodes', (nodeCount) => {
    expect(q.validateConfiguration({ nodeCount }).ok).toBe(false);
  });

  it.each([1, 3, 24])('accepts %p nodes', (nodeCount) => {
    expect(q.validateConfiguration({ nodeCount }).ok).toBe(true);
  });

  it.each([49, 50001, 100.5])('rejects a soft capacity of %p TB', (softCapacityTB) => {
    expect(q.validateConfiguration({ softCapacityTB }).ok).toBe(false);
  });

  it('rejects an unknown persistent storage type', () => {
    expect(q.validateConfiguration({ persistentStorageType: 'glacier' }).ok).toBe(false);
  });
});

describe('names', () => {
  it('starts both stack names with the prefix the service role is scoped to', () => {
    const { computeStackName, storageStackName } = q.stackNames('MRM', STORAGE_ID);
    expect(computeStackName).toBe('MRM-Qumulo-3f9a1c2e');
    expect(storageStackName).toBe('MRM-Qumulo-3f9a1c2e-Data');
    expect(computeStackName.startsWith('MRM-Qumulo-')).toBe(true);
    expect(storageStackName.startsWith('MRM-Qumulo-')).toBe(true);
  });

  it.each(['Edit Room 1', '', '!!!', 'a'.repeat(60), 'Édition ☃'])(
    'makes a valid cluster name from %p', (name) => {
      expect(q.clusterName(name, STORAGE_ID)).toMatch(/^[A-Za-z0-9-]{2,15}$/);
    }
  );

  it('keeps clusters unique across storages with the same name', () => {
    expect(q.clusterName('Edit', 'aaaaaaaa-1')).not.toBe(q.clusterName('Edit', 'bbbbbbbb-1'));
  });
});

describe('generateAdminPassword', () => {
  it('always satisfies the template pattern and never starts with a special character', () => {
    for (let i = 0; i < 500; i++) {
      const password = q.generateAdminPassword();
      expect(password).toMatch(QUMULO_PASSWORD_PATTERN);
      expect(password[0]).toMatch(/[A-Za-z0-9]/);
    }
  });

  it('does not repeat', () => {
    expect(q.generateAdminPassword()).not.toBe(q.generateAdminPassword());
  });
});

describe('storage stack parameters', () => {
  const params = asMap(q.buildStorageParameters({
    bucket: 'assets', region: 'us-east-1', boundaryPolicyName: 'MRM-QumuloBoundary', softCapacityTB: 120
  }));

  it('points at the staged templates with a trailing slash on the prefix', () => {
    expect(params.QSS3BucketName).toBe('assets');
    expect(params.QSS3KeyPrefix).toBe('cnq/');
    expect(params.QSS3BucketRegion).toBe('us-east-1');
  });

  it('turns bucket protection on and applies the boundary', () => {
    expect(params.QPersistentBucketProtect).toBe('YES');
    expect(params.QPermissionsBoundary).toBe('MRM-QumuloBoundary');
    expect(params.QSoftCapacityLimit).toBe('120');
  });
});

describe('compute stack parameters', () => {
  const list = q.buildComputeParameters({
    bucket: 'assets',
    region: 'us-east-1',
    keyName: 'mrm-storage-appliance-key',
    network: { vpcId: 'vpc-1', vpcCidr: '10.0.0.0/16', subnet1: 'subnet-a', subnet2: 'subnet-b' },
    storageStackName: 'MRM-Qumulo-3f9a1c2e-Data',
    clusterName: 'edit-3f9a1',
    adminPassword: 'Abcdefg_h1',
    coreVersion: '7.10.3.2',
    boundaryPolicyName: 'MRM-QumuloBoundary',
    configuration: q.validateConfiguration({}).value
  });
  const params = asMap(list);

  it('names every parameter once, with a non-empty string value', () => {
    expect(new Set(list.map((p: { ParameterKey: string }) => p.ParameterKey)).size).toBe(list.length);
    for (const p of list) {
      expect(typeof p.ParameterValue).toBe('string');
      expect(p.ParameterValue.length).toBeGreaterThan(0);
    }
  });

  it('links to the storage stack it depends on', () => {
    expect(params.QPersistentStorageDeploymentStackName).toBe('MRM-Qumulo-3f9a1c2e-Data');
  });

  it('applies the boundary, termination protection, and a single availability zone', () => {
    expect(params.QPermissionsBoundary).toBe('MRM-QumuloBoundary');
    expect(params.TermProtection).toBe('YES');
    expect(params.NumberAZs).toBe('1');
    expect(params.QReplacementCluster).toBe('NO');
  });

  it('puts the second subnet in a different place from the first', () => {
    expect(params.PrivateSubnetIDs).toBe('subnet-a');
    expect(params.SecondPrivateSubnetID).toBe('subnet-b');
  });

  it('opens the cluster to the VPC and carries size settings through', () => {
    expect(params.QSgCidr1).toBe('10.0.0.0/16');
    expect(params.QInstanceType).toBe('m6i.xlarge');
    expect(params.QNodeCount).toBe('1');
    expect(params.QClusterVersion).toBe('7.10.3.2');
  });
});

describe('templateUrl', () => {
  it('builds the regional S3 URL Qumulo documents', () => {
    expect(q.templateUrl('assets', 'us-east-1', q.COMPUTE_TEMPLATE)).toBe(
      'https://assets.s3.us-east-1.amazonaws.com/cnq/templates/cnq-advanced.template.yaml'
    );
  });
});

describe('outputs', () => {
  it('turns the output list into a map', () => {
    expect(q.outputsToMap([{ OutputKey: 'A', OutputValue: '1' }])).toEqual({ A: '1' });
    expect(q.outputsToMap(undefined)).toEqual({});
  });

  it('reads the cluster address out of the URL Qumulo reports', () => {
    expect(q.privateIpFromUrl('https://10.0.138.96')).toBe('10.0.138.96');
    expect(q.privateIpFromUrl('10.0.138.96')).toBe('10.0.138.96');
    expect(q.privateIpFromUrl(undefined)).toBe('N/A');
  });
});

describe('the create-storage copy of params.js', () => {
  it('is identical to the worker original, because Lambda packages cannot share files', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    expect(read('lambda/create-storage/qumulo-params.js')).toBe(read('lambda/qumulo-cfn-worker/params.js'));
  });
});

export {};
