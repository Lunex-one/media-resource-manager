// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface QumuloStorageProps {
  acronym: string;
  pascalCaseName: string;
  storageTable: dynamodb.ITable;
  dataEncryptionKey?: kms.IKey;
  /** EC2 key pair name the storage appliances (NEXIS, Qumulo) are launched with. */
  applianceKeyName: string;
}

/**
 * Cloud Native Qumulo as an MRM storage type.
 *
 * Qumulo ships its own CloudFormation templates (two stacks: persistent S3 buckets, then the
 * cluster). Those stacks create IAM roles, Lambdas, KMS grants and dozens of nested stacks, so they
 * do not run under the shared storage worker's identity. Instead:
 *
 *  - qumulo-cfn-worker may only manage `<acronym>-Qumulo-*` stacks and pass ONE role to CloudFormation;
 *  - that role (the CFN service role) holds the rights Qumulo's documentation lists, with IAM writes
 *    limited to `<acronym>-Qumulo-*` names and a required permissions boundary;
 *  - the boundary caps what every role Qumulo creates can reach (Secrets Manager and SSM only under
 *    qumulo paths, SendCommand only on Qumulo-tagged instances, no IAM writes). Qumulo's provisioner
 *    otherwise attaches SecretsManagerReadWrite, which is every secret in the account.
 *
 * The templates and Qumulo Core's .deb come from Qumulo and are licensed, so an operator stages them
 * in the assets bucket with scripts/stage-qumulo.sh. That script also sets the Core version.
 *
 * Trust anchor: whoever can write the assets bucket controls what the service role builds. Users of
 * MRM only choose parameters (name, size).
 */
export class QumuloStorage extends Construct {
  public readonly assetsBucket: s3.Bucket;
  public readonly boundaryPolicy: iam.ManagedPolicy;
  public readonly serviceRole: iam.Role;
  public readonly worker: lambda.Function;
  public readonly creationStateMachine: stepfunctions.StateMachine;
  public readonly deletionStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: QumuloStorageProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const { acronym, pascalCaseName } = props;
    const lowerAcronym = acronym.toLowerCase();
    const { account, region, partition } = stack;

    // ---------------------------------------------------------------- assets bucket
    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The staging script reads the bucket name from here; the Core version parameter next to it
    // (`/<product>/Qumulo/CoreVersion`) is written by that script, not by CDK, so a deploy never
    // overwrites it.
    new ssm.StringParameter(this, 'AssetsBucketParameter', {
      parameterName: `/${pascalCaseName}/Qumulo/AssetsBucket`,
      stringValue: this.assetsBucket.bucketName,
      description: 'Bucket the operator stages Qumulo CloudFormation templates and Qumulo Core into',
    });

    // ---------------------------------------------------------------- permissions boundary
    const boundaryName = `${acronym}-QumuloBoundary`;
    const qumuloSecrets = `arn:${partition}:secretsmanager:${region}:${account}:secret:qumulo/*`;
    const qumuloParameters = `arn:${partition}:ssm:${region}:${account}:parameter/qumulo/*`;
    const publicParameters = `arn:${partition}:ssm:${region}::parameter/aws/service/*`;
    const notQumuloTagged = { StringNotEquals: { 'ssm:resourceTag/MrmStorageType': 'qumulo' } };

    this.boundaryPolicy = new iam.ManagedPolicy(this, 'Boundary', {
      managedPolicyName: boundaryName,
      description: 'Caps every role created by the Qumulo CloudFormation stacks',
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'AllowWithinRolePolicies',
            effect: iam.Effect.ALLOW,
            actions: ['*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'SecretsOnlyQumulo',
            effect: iam.Effect.DENY,
            actions: ['secretsmanager:*'],
            notResources: [qumuloSecrets],
          }),
          new iam.PolicyStatement({
            sid: 'ParametersOnlyQumuloAndPublic',
            effect: iam.Effect.DENY,
            actions: [
              'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath',
              'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:DeleteParameters',
            ],
            notResources: [qumuloParameters, publicParameters],
          }),
          new iam.PolicyStatement({
            sid: 'CommandsOnlyOnQumuloInstances',
            effect: iam.Effect.DENY,
            actions: ['ssm:SendCommand'],
            resources: [`arn:${partition}:ec2:*:*:instance/*`],
            conditions: notQumuloTagged,
          }),
          new iam.PolicyStatement({
            sid: 'InstanceChangesOnlyOnQumulo',
            effect: iam.Effect.DENY,
            actions: ['ec2:ModifyInstanceAttribute', 'ec2:ModifyInstanceMetadataOptions'],
            resources: [`arn:${partition}:ec2:*:*:instance/*`],
            conditions: { StringNotEquals: { 'aws:ResourceTag/MrmStorageType': 'qumulo' } },
          }),
          new iam.PolicyStatement({
            sid: 'NoIamWrites',
            effect: iam.Effect.DENY,
            actions: [
              'iam:CreateUser', 'iam:CreateRole', 'iam:CreateAccessKey', 'iam:CreateLoginProfile',
              'iam:AttachRolePolicy', 'iam:AttachUserPolicy', 'iam:PutRolePolicy', 'iam:PutUserPolicy',
              'iam:UpdateAssumeRolePolicy', 'iam:PutRolePermissionsBoundary', 'iam:DeleteRolePermissionsBoundary',
            ],
            resources: ['*'],
          }),
        ],
      }),
    });

    // ---------------------------------------------------------------- CloudFormation service role
    const boundaryArn = this.boundaryPolicy.managedPolicyArn;
    const rolePrefix = `arn:${partition}:iam::${account}:role/${acronym}-Qumulo-*`;
    // Qumulo's one role that does not take QPermissionsBoundary: a helper Lambda that sorts subnets
    // by zone (logs, ec2:DescribeSubnets, sts:GetCallerIdentity only).
    const helperLambdaRole = `arn:${partition}:iam::${account}:role/${acronym}-Qumulo-*-LambdaExecutionRole-*`;
    const profilePrefix = `arn:${partition}:iam::${account}:instance-profile/${acronym}-Qumulo-*`;

    this.serviceRole = new iam.Role(this, 'CfnServiceRole', {
      roleName: `${acronym}-QumuloCfnServiceRole`,
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Role CloudFormation assumes to build and delete Qumulo clusters',
    });

    const allow = (statement: iam.PolicyStatementProps) =>
      this.serviceRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, ...statement }));

    // Services Qumulo's documentation lists, without a usable resource scope for their generated names.
    allow({
      actions: [
        'ec2:*', 'elasticloadbalancing:*', 'lambda:*', 'logs:*', 'resource-groups:*', 'route53:*',
        'route53resolver:*', 'sns:*', 'sts:*', 'cloudformation:*',
        'kms:CreateGrant', 'kms:DescribeKey', 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*',
        'kms:ReEncrypt*', 'kms:ListAliases', 'kms:ListGrants', 'kms:RevokeGrant',
      ],
      resources: ['*'],
    });

    // Persistent buckets have generated names ending in the stack name, lower-cased.
    allow({
      actions: ['s3:*'],
      resources: [
        `arn:${partition}:s3:::*-${lowerAcronym}-qumulo-*`,
        `arn:${partition}:s3:::*-${lowerAcronym}-qumulo-*/*`,
      ],
    });
    allow({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [this.assetsBucket.bucketArn, this.assetsBucket.arnForObjects('*')],
    });

    allow({ actions: ['secretsmanager:*'], resources: [qumuloSecrets] });
    allow({ actions: ['secretsmanager:GetRandomPassword'], resources: ['*'] });
    allow({
      actions: [
        'ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter', 'ssm:DeleteParameter',
        'ssm:DeleteParameters', 'ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource', 'ssm:ListTagsForResource',
      ],
      resources: [qumuloParameters],
    });
    allow({ actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: [publicParameters] });
    allow({ actions: ['ssm:DescribeParameters'], resources: ['*'] });

    // IAM: every role must carry the boundary (except the helper Lambda's), and the only AWS managed
    // policies that may be attached are the two Qumulo's templates use.
    allow({
      actions: ['iam:CreateRole', 'iam:PutRolePolicy'],
      resources: [rolePrefix],
      conditions: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    });
    allow({
      actions: ['iam:AttachRolePolicy'],
      resources: [rolePrefix],
      conditions: {
        StringEquals: {
          'iam:PermissionsBoundary': boundaryArn,
          'iam:PolicyARN': [
            `arn:${partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`,
            `arn:${partition}:iam::aws:policy/SecretsManagerReadWrite`,
          ],
        },
      },
    });
    allow({ actions: ['iam:CreateRole', 'iam:PutRolePolicy'], resources: [helperLambdaRole] });
    allow({
      actions: [
        'iam:DeleteRole', 'iam:GetRole', 'iam:TagRole', 'iam:UntagRole', 'iam:DeleteRolePolicy',
        'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:DetachRolePolicy',
        'iam:ListInstanceProfilesForRole',
      ],
      resources: [rolePrefix],
    });
    allow({
      actions: ['iam:PassRole'],
      resources: [rolePrefix],
      conditions: { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'ec2.amazonaws.com'] } },
    });
    allow({
      actions: [
        'iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile',
        'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile', 'iam:TagInstanceProfile',
      ],
      resources: [profilePrefix],
    });

    // ---------------------------------------------------------------- worker Lambda
    this.worker = new lambda.Function(this, 'Worker', {
      functionName: `${lowerAcronym}-qumulo-cfn-worker`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/qumulo-cfn-worker'),
      description: 'Creates, polls and deletes Cloud Native Qumulo CloudFormation stacks',
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: pascalCaseName,
        ACRONYM: acronym,
        ASSETS_BUCKET: this.assetsBucket.bucketName,
        SERVICE_ROLE_ARN: this.serviceRole.roleArn,
        BOUNDARY_POLICY_NAME: boundaryName,
        KEY_NAME: props.applianceKeyName,
      },
    });

    const stacks = `arn:${partition}:cloudformation:${region}:${account}:stack/${acronym}-Qumulo-*/*`;
    this.worker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:CreateStack', 'cloudformation:DescribeStacks', 'cloudformation:DeleteStack',
        'cloudformation:UpdateStack', 'cloudformation:UpdateTerminationProtection',
        'cloudformation:DescribeStackEvents',
        // Qumulo's nested templates use the AWS::LanguageExtensions transform; CloudFormation expands it
        // through an internal change set made with the caller's identity.
        'cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet',
        'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet',
      ],
      resources: [stacks, `arn:${partition}:cloudformation:${region}:aws:transform/*`],
    }));
    this.worker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [this.serviceRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }));
    // CloudFormation fetches the templates with the caller's identity.
    this.worker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [this.assetsBucket.arnForObjects('*')],
    }));
    this.worker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [this.assetsBucket.bucketArn],
    }));
    this.worker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:${partition}:ssm:${region}:${account}:parameter/${pascalCaseName}/Network/*`,
        `arn:${partition}:ssm:${region}:${account}:parameter/${pascalCaseName}/Qumulo/*`,
      ],
    }));
    this.worker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:CreateSecret', 'secretsmanager:TagResource'],
      resources: [
        `arn:${partition}:secretsmanager:${region}:${account}:secret:/${pascalCaseName}/Storage/*/QumuloAdminPassword*`,
      ],
    }));

    // ---------------------------------------------------------------- state machines
    const transientRetry = [{
      ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'],
      IntervalSeconds: 5,
      MaxAttempts: 4,
      BackoffRate: 2.0,
    }];
    const readRetry = [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 10, MaxAttempts: 3, BackoffRate: 2.0 }];
    const tableRetry = [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }];

    const updateItem = (expression: string, values: Record<string, unknown>, next?: string) => ({
      Type: 'Task',
      Resource: 'arn:aws:states:::dynamodb:updateItem',
      Parameters: {
        TableName: props.storageTable.tableName,
        Key: { storageId: { 'S.$': '$.storageId' } },
        UpdateExpression: expression,
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':updatedAt': { 'S.$': '$$.State.EnteredTime' }, ...values },
      },
      ResultPath: null,
      ...(next ? { Next: next } : { End: true }),
      Retry: tableRetry,
    });

    const workerTask = (
      parameters: Record<string, unknown>, resultPath: string, next: string,
      retry: unknown[], failure: string,
    ) => ({
      Type: 'Task',
      Resource: this.worker.functionArn,
      Parameters: parameters,
      ResultPath: resultPath,
      Next: next,
      Retry: retry,
      Catch: [{ ErrorEquals: ['States.ALL'], Next: failure, ResultPath: '$.error' }],
    });

    const status = '$.stackStatus.Stacks[0].StackStatus';

    const evaluateCreation = (wait: string, complete: string, failure: string) => ({
      Type: 'Choice',
      Choices: [
        { Variable: status, StringEquals: 'CREATE_COMPLETE', Next: complete },
        { Variable: status, StringMatches: '*_FAILED', Next: failure },
        { Variable: status, StringEquals: 'ROLLBACK_COMPLETE', Next: failure },
        { Variable: status, StringMatches: '*_IN_PROGRESS', Next: wait },
      ],
      Default: failure,
    });

    const stackFailureMessage =
      "States.Format('Qumulo stack {} ended with status {}: {}', $.stackStatus.Stacks[0].StackName, $.stackStatus.Stacks[0].StackStatus, $.stackStatus.Stacks[0].StackStatusReason)";

    const creationDefinition = {
      Comment: 'Cloud Native Qumulo creation: persistent storage stack, then the cluster stack',
      StartAt: 'UpdateStatusToCreating',
      States: {
        UpdateStatusToCreating: updateItem(
          'SET #status = :status, #updatedAt = :updatedAt, cloudFormationStackName = :compute, qumuloStorageStackName = :storage',
          {
            ':status': { S: 'creating' },
            ':compute': { 'S.$': '$.computeStackName' },
            ':storage': { 'S.$': '$.storageStackName' },
          },
          'CreateStorageStack',
        ),
        CreateStorageStack: workerTask(
          {
            action: 'createStack',
            kind: 'storage',
            'stackName.$': '$.storageStackName',
            'configuration.$': '$.configuration',
            'references.$': '$.references',
          },
          '$.storageStack', 'WaitForStorageStack', transientRetry, 'PrepareFailureFromError',
        ),
        WaitForStorageStack: { Type: 'Wait', Seconds: 30, Next: 'CheckStorageStack' },
        CheckStorageStack: workerTask(
          { action: 'describeStacks', 'stackName.$': '$.storageStackName' },
          '$.stackStatus', 'EvaluateStorageStack', readRetry, 'PrepareFailureFromError',
        ),
        EvaluateStorageStack: evaluateCreation('WaitForStorageStack', 'CreateComputeStack', 'PrepareFailureFromStack'),
        CreateComputeStack: workerTask(
          {
            action: 'createStack',
            kind: 'compute',
            'stackName.$': '$.computeStackName',
            'storageStackName.$': '$.storageStackName',
            'storageId.$': '$.storageId',
            'name.$': '$.name',
            'configuration.$': '$.configuration',
            'references.$': '$.references',
          },
          '$.computeStack', 'WaitForComputeStack', transientRetry, 'PrepareFailureFromError',
        ),
        WaitForComputeStack: { Type: 'Wait', Seconds: 60, Next: 'CheckComputeStack' },
        CheckComputeStack: workerTask(
          { action: 'describeStacks', 'stackName.$': '$.computeStackName' },
          '$.stackStatus', 'EvaluateComputeStack', readRetry, 'PrepareFailureFromError',
        ),
        EvaluateComputeStack: evaluateCreation('WaitForComputeStack', 'UpdateStatusToAvailable', 'PrepareFailureFromStack'),
        UpdateStatusToAvailable: updateItem(
          'SET #status = :status, #updatedAt = :updatedAt, qumuloUrl = :url, qumuloPrivateIp = :ip, parsedOutputs = :outputs',
          {
            ':status': { S: 'available' },
            ':url': { 'S.$': '$.stackStatus.qumuloUrl' },
            ':ip': { 'S.$': '$.stackStatus.qumuloPrivateIp' },
            ':outputs': { 'S.$': 'States.JsonToString($.stackStatus.outputs)' },
          },
        ),
        PrepareFailureFromStack: {
          Type: 'Pass',
          Parameters: { 'storageId.$': '$.storageId', 'errorMessage.$': stackFailureMessage },
          Next: 'UpdateStatusToFailed',
        },
        PrepareFailureFromError: {
          Type: 'Pass',
          Parameters: { 'storageId.$': '$.storageId', 'errorMessage.$': "States.Format('Error: {}', $.error.Cause)" },
          Next: 'UpdateStatusToFailed',
        },
        UpdateStatusToFailed: updateItem(
          'SET #status = :status, #updatedAt = :updatedAt, errorMessage = :error',
          { ':status': { S: 'failed' }, ':error': { 'S.$': '$.errorMessage' } },
        ),
      },
    };

    const evaluateDeletion = (wait: string, done: string, failure: string) => ({
      Type: 'Choice',
      Choices: [
        { Variable: status, StringEquals: 'DELETE_COMPLETE', Next: done },
        { Variable: status, StringMatches: '*_IN_PROGRESS', Next: wait },
      ],
      Default: failure,
    });

    const deletionDefinition = {
      Comment: 'Cloud Native Qumulo deletion: turn protections off, delete the cluster stack, then the storage stack',
      StartAt: 'UpdateStatusToDeleting',
      States: {
        UpdateStatusToDeleting: updateItem(
          'SET #status = :status, #updatedAt = :updatedAt',
          { ':status': { S: 'deleting' } },
          'DisableProtection',
        ),
        DisableProtection: workerTask(
          {
            action: 'disableProtection',
            'storageStackName.$': '$.storageStackName',
            'computeStackName.$': '$.computeStackName',
          },
          '$.protection', 'EvaluateProtection', transientRetry, 'PrepareDeleteFailureFromError',
        ),
        EvaluateProtection: {
          Type: 'Choice',
          Choices: [{ Variable: '$.protection.status', StringEquals: 'UPDATE_IN_PROGRESS', Next: 'WaitForProtectionUpdate' }],
          Default: 'DeleteComputeStack',
        },
        WaitForProtectionUpdate: { Type: 'Wait', Seconds: 30, Next: 'CheckProtectionUpdate' },
        CheckProtectionUpdate: workerTask(
          { action: 'describeStacks', 'stackName.$': '$.storageStackName' },
          '$.stackStatus', 'EvaluateProtectionUpdate', readRetry, 'PrepareDeleteFailureFromError',
        ),
        EvaluateProtectionUpdate: {
          Type: 'Choice',
          Choices: [
            { Variable: status, StringEquals: 'UPDATE_COMPLETE', Next: 'DeleteComputeStack' },
            { Variable: status, StringMatches: '*_IN_PROGRESS', Next: 'WaitForProtectionUpdate' },
          ],
          Default: 'PrepareDeleteFailureFromStack',
        },
        DeleteComputeStack: workerTask(
          { action: 'deleteStack', 'stackName.$': '$.computeStackName' },
          '$.computeDelete', 'WaitForComputeDeletion', transientRetry, 'PrepareDeleteFailureFromError',
        ),
        WaitForComputeDeletion: { Type: 'Wait', Seconds: 60, Next: 'CheckComputeDeletion' },
        CheckComputeDeletion: workerTask(
          { action: 'describeStacks', 'stackName.$': '$.computeStackName' },
          '$.stackStatus', 'EvaluateComputeDeletion', readRetry, 'PrepareDeleteFailureFromError',
        ),
        EvaluateComputeDeletion: evaluateDeletion('WaitForComputeDeletion', 'DeleteStorageStack', 'PrepareDeleteFailureFromStack'),
        DeleteStorageStack: workerTask(
          { action: 'deleteStack', 'stackName.$': '$.storageStackName' },
          '$.storageDelete', 'WaitForStorageDeletion', transientRetry, 'PrepareDeleteFailureFromError',
        ),
        WaitForStorageDeletion: { Type: 'Wait', Seconds: 60, Next: 'CheckStorageDeletion' },
        CheckStorageDeletion: workerTask(
          { action: 'describeStacks', 'stackName.$': '$.storageStackName' },
          '$.stackStatus', 'EvaluateStorageDeletion', readRetry, 'PrepareDeleteFailureFromError',
        ),
        EvaluateStorageDeletion: evaluateDeletion('WaitForStorageDeletion', 'DeleteRecord', 'PrepareDeleteFailureFromStack'),
        DeleteRecord: {
          Type: 'Task',
          Resource: 'arn:aws:states:::dynamodb:deleteItem',
          Parameters: {
            TableName: props.storageTable.tableName,
            Key: { storageId: { 'S.$': '$.storageId' } },
          },
          End: true,
          Retry: tableRetry,
        },
        PrepareDeleteFailureFromStack: {
          Type: 'Pass',
          Parameters: { 'storageId.$': '$.storageId', 'errorMessage.$': stackFailureMessage },
          Next: 'UpdateStatusToDeleteFailed',
        },
        PrepareDeleteFailureFromError: {
          Type: 'Pass',
          Parameters: { 'storageId.$': '$.storageId', 'errorMessage.$': "States.Format('Error: {}', $.error.Cause)" },
          Next: 'UpdateStatusToDeleteFailed',
        },
        UpdateStatusToDeleteFailed: updateItem(
          'SET #status = :status, #updatedAt = :updatedAt, errorMessage = :error',
          { ':status': { S: 'delete-failed' }, ':error': { 'S.$': '$.errorMessage' } },
        ),
      },
    };

    this.creationStateMachine = new stepfunctions.StateMachine(this, 'CreationStateMachine', {
      stateMachineName: `${lowerAcronym}-qumulo-creation`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(creationDefinition)),
      timeout: cdk.Duration.hours(3),
    });
    this.deletionStateMachine = new stepfunctions.StateMachine(this, 'DeletionStateMachine', {
      stateMachineName: `${lowerAcronym}-qumulo-deletion`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(deletionDefinition)),
      timeout: cdk.Duration.hours(3),
    });

    for (const machine of [this.creationStateMachine, this.deletionStateMachine]) {
      this.worker.grantInvoke(machine);
      props.storageTable.grantReadWriteData(machine);
      props.dataEncryptionKey?.grantEncryptDecrypt(machine);
    }

    new cdk.CfnOutput(this, 'QumuloAssetsBucketName', {
      value: this.assetsBucket.bucketName,
      description: 'Stage Qumulo templates and Qumulo Core here with scripts/stage-qumulo.sh',
    });
  }
}
