// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the workstation-creation state machines' writes to the workstation record.
 *
 * Each build writes its progress onto the record with DynamoDB UpdateItem. Those writes carried no
 * ConditionExpression, and UpdateItem creates the item when it is absent - so a build that carried
 * on after DELETE /workstations/{id} wrote back the record that delete had just removed. Delete
 * terminates the instance and deletes the record but leaves the build's execution running; the
 * next SSM step fails against the terminated instance, and the failure write re-creates the record.
 *
 * What came back was a stub holding only the attributes that one update sets. Three such rows were
 * found on 2026-10-20 - i-0a43c058e45e54af6, i-01f47ee33cbd1a470 and i-0d7134c69c5531115 - two of
 * them carrying UpdateStatusSsmInstallFailed's errorMessage, "DCV installation SSM command failed".
 *
 * The record is created by the instance-create-* Lambda that is each machine's first state, so
 * every one of these writes can require it to exist. This locks in that guard, and the catch that
 * ends a build whose workstation was deleted in WorkstationDeletedDuringBuild. The API's own
 * writes to the record got the same guard in test/workstation-self-heal.test.ts.
 */

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { WindowsWorkstationCreationStack } from '../lib/workstation-creation-stack-windows';
import { LinuxWorkstationCreationStack } from '../lib/workstation-creation-stack-linux';
import { MacOSWorkstationCreationStack } from '../lib/workstation-creation-stack-macos';
import { WorkstationRecordGuard } from '../lib/workstation-record-guard';

type State = {
  Type: string;
  Resource?: string;
  Parameters?: Record<string, unknown>;
  Catch?: { ErrorEquals: string[]; Next: string }[];
  Error?: string;
};

// The partition in the ARN is a token, so match on the rest of it.
const UPDATE_ITEM = ':states:::aws-sdk:dynamodb:updateItem';

/** Synthesize the three creation stacks against stand-in shared resources. */
function synthAll(): Record<string, Template> {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const shared = new cdk.Stack(app, 'Shared', { env });
  const table = (id: string) => new dynamodb.Table(shared, id, {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
  });
  const vpc = new ec2.Vpc(shared, 'Vpc');
  const workstationSecurityGroup = new ec2.SecurityGroup(shared, 'Sg', { vpc });
  const workstationLaunchTemplate = new ec2.LaunchTemplate(shared, 'Lt', {
    role: new iam.Role(shared, 'Role', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') }),
  });
  const sessionCleanupFunction = lambda.Function.fromFunctionArn(
    shared, 'Cleanup', 'arn:aws:lambda:us-east-1:123456789012:function:cleanup');

  const common = {
    env,
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    workstationTable: table('Workstations'),
    imagePipelinesTable: table('Pipelines'),
    amiTable: table('Amis'),
    hostnameCounterTable: table('Counters'),
    vpc,
    workstationSecurityGroup,
    sessionCleanupFunction,
  };
  const regionalHubsTable = table('Hubs');

  const windows = new WindowsWorkstationCreationStack(app, 'Windows', {
    ...common, workstationLaunchTemplate,
  });
  const linux = new LinuxWorkstationCreationStack(app, 'Linux', {
    ...common, workstationLaunchTemplate, regionalHubsTable,
  });
  const macos = new MacOSWorkstationCreationStack(app, 'MacOS', {
    ...common, regionalHubsTable,
  });
  return {
    windows: Template.fromStack(windows),
    linux: Template.fromStack(linux),
    macos: Template.fromStack(macos),
  };
}

/**
 * The template holds the definition as an Fn::Join of strings and tokens. The tokens are table
 * names and function ARNs, none of which the assertions read, so each becomes a placeholder.
 */
function statesOf(template: Template): Record<string, State> {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const ids = Object.keys(machines);
  expect(ids).toHaveLength(1);
  const definition = machines[ids[0]].Properties.DefinitionString;
  const [, parts] = definition['Fn::Join'] as [string, unknown[]];
  const json = parts.map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
  return JSON.parse(json).States;
}

const templates = synthAll();

describe.each([
  // The number of updateItem states each machine holds today: Windows names fifteen, Linux and
  // macOS name six and five plus one per failure branch built by createFailureUpdate.
  ['windows', 15],
  ['linux', 13],
  ['macos', 11],
])('%s workstation creation', (platform, expectedWrites) => {
  const states = statesOf(templates[platform]);
  const writes = Object.entries(states).filter(([, s]) => s.Resource?.endsWith(UPDATE_ITEM));

  it('writes to the workstation record where expected', () => {
    // A count that moves means a write was added or removed; check the new one is guarded.
    expect(writes).toHaveLength(expectedWrites);
  });

  it('refuses to create a workstation record that is no longer there', () => {
    for (const [name, state] of writes) {
      expect([name, state.Parameters?.ConditionExpression])
        .toEqual([name, 'attribute_exists(instanceId)']);
    }
  });

  it('ends the build in WorkstationDeletedDuringBuild when the record is gone', () => {
    for (const [name, state] of writes) {
      expect([name, state.Catch]).toEqual([name, [
        expect.objectContaining({
          ErrorEquals: [WorkstationRecordGuard.RECORD_GONE_ERROR],
          Next: 'WorkstationDeletedDuringBuild',
        }),
      ]]);
    }
    expect(states.WorkstationDeletedDuringBuild).toMatchObject({
      Type: 'Fail',
      Error: 'WorkstationDeletedDuringBuild',
    });
  });

  it('catches the error name the AWS SDK integration raises', () => {
    // CallAwsService synthesizes arn:aws:states:::aws-sdk:dynamodb:*, whose errors carry the SDK
    // exception prefix DynamoDb. DynamoDB.ConditionalCheckFailedException is the optimized
    // integration's name and would never match here.
    expect(WorkstationRecordGuard.RECORD_GONE_ERROR).toBe('DynamoDb.ConditionalCheckFailedException');
  });
});
