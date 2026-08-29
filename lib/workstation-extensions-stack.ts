// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Split out of ApiStack (MRM-Api) to stay under CloudFormation's 500-resource-per-stack
 * limit. Depends one-way on ApiStack (workstationManagerFunction, workstationsResource,
 * authorizer passed in as props); ApiStack needs nothing back from here — it reads this
 * stack's Lambda ARN via SSM (see NexisNetworkAccessManagerArnParam below), matching the
 * existing NFS mount manager cross-stack pattern in storage-stack.ts.
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface WorkstationExtensionsStackProps extends cdk.StackProps {
  acronym: string;
  pascalCaseName: string;
  storageTable: dynamodb.Table;
  workstationTable: dynamodb.Table;
  dataEncryptionKey?: kms.IKey;
  workstationManagerFunction: lambda.IFunction;
  workstationsResource: apigateway.IResource;
  authorizer: apigateway.IAuthorizer;
}

export class WorkstationExtensionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkstationExtensionsStackProps) {
    super(scope, id, props);

    // Avid NEXIS Network Access Manager - reconciles a workstation's network interface
    // security groups against its desired NEXIS access. Platform-agnostic (unlike the
    // SMB/NFS mount managers) since it's purely a network change, not a filesystem mount.
    const nexisNetworkAccessManagerFunction = new lambda.Function(this, 'NexisNetworkAccessManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-nexis-network-access-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/nexis-network-access-manager'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      description: 'Reconcile workstation network interface security groups for Avid NEXIS access',
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      }
    });

    props.storageTable.grantReadData(nexisNetworkAccessManagerFunction);
    props.workstationTable.grantReadData(nexisNetworkAccessManagerFunction);

    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(nexisNetworkAccessManagerFunction);
    }

    nexisNetworkAccessManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
        'ec2:ModifyNetworkInterfaceAttribute'
      ],
      resources: ['*'], // Cross-region (regional hub workstations) requires wildcard
    }));

    // Store the ARN in SSM for loose cross-stack coupling - ApiStack reads this to set
    // workstationManagerFunction's NEXIS_NETWORK_ACCESS_MANAGER_FUNCTION_ARN env var,
    // avoiding a circular dependency between the two stacks.
    new ssm.StringParameter(this, 'NexisNetworkAccessManagerArnParam', {
      parameterName: `/${props.pascalCaseName}/Storage/NexisNetworkAccessManagerFunctionArn`,
      stringValue: nexisNetworkAccessManagerFunction.functionArn,
      description: 'NEXIS Network Access Manager Lambda ARN for cross-stack reference',
    });

    // /workstations/orphans and /workstations/executions - moved from ApiStack for the
    // same resource-count reason. Both are handled by workstation-manager, same as before.
    const workstationIntegration = new apigateway.LambdaIntegration(props.workstationManagerFunction);

    const orphansResource = props.workstationsResource.addResource('orphans');
    orphansResource.addMethod('GET', workstationIntegration, { authorizer: props.authorizer });

    const workstationExecutionsResource = props.workstationsResource.addResource('executions');
    workstationExecutionsResource.addMethod('GET', workstationIntegration, { authorizer: props.authorizer });
  }
}
