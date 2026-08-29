// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Split out of ApiStack (MRM-Api) to stay under CloudFormation's 500-resource-per-stack
 * limit - this was by far the largest single route family (/images/* covering AMIs,
 * pipelines, and the software library), so moving it out buys real headroom rather
 * than just squeaking under the limit.
 *
 * One-way dependency on ApiStack: reuses its shared lambdaRole and lambdaEnvironment
 * (passed in as direct construct/value props) so these two functions keep the exact
 * same permissions and environment they had before the move, and attaches new
 * resources/methods directly onto ApiStack's existing RestApi via props.api.root.
 * ApiStack needs nothing back from this stack.
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface ImageManagementStackProps extends cdk.StackProps {
  acronym: string;
  pascalCaseName: string;
  amiTable: dynamodb.Table;
  imagePipelinesTable: dynamodb.Table;
  regionalHubsTable: dynamodb.Table;
  softwareLibraryTable: dynamodb.Table;
  dataEncryptionKey?: kms.IKey;
  imageBuilderInstanceProfile: string;
  imageBuilderLogsBucket: string;
  imageBuilderServiceRoleArn: string;
  imageBuilderUploadsBucket: string;
  buildSubnetId: string;
  buildSecurityGroupId: string;
  lambdaRole: iam.IRole;
  lambdaEnvironment: Record<string, string>;
  api: apigateway.RestApi;
  authorizer: apigateway.IAuthorizer;
  invokeInstallScriptAgentFunction?: lambda.IFunction;
  installScriptProgressFunction?: lambda.IFunction;
  cancelInstallScriptFunction?: lambda.IFunction;
  chatRequirementsFunction?: lambda.IFunction;
}

export class ImageManagementStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ImageManagementStackProps) {
    super(scope, id, props);

    const authorizer = props.authorizer;

    // Image Management Lambda function
    const imageManagerFunction = new lambda.Function(this, 'ImageManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-image-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Image management function',
      code: lambda.Code.fromAsset('lambda/image-manager'),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        ...props.lambdaEnvironment,
        IMAGES_TABLE_NAME: props.amiTable.tableName,
        PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGE_BUILDER_INSTANCE_PROFILE: props.imageBuilderInstanceProfile,
        LOGS_BUCKET_NAME: props.imageBuilderLogsBucket,
        BUILD_SUBNET_ID: props.buildSubnetId,
        BUILD_SECURITY_GROUP_ID: props.buildSecurityGroupId,
        IMAGE_BUILDER_SERVICE_ROLE_ARN: props.imageBuilderServiceRoleArn,
        PASCAL_CASE_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
      role: props.lambdaRole,
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
    });

    // Grant image function access to AMI table
    props.amiTable.grantReadWriteData(imageManagerFunction);
    // Grant access to pipelines table
    props.imagePipelinesTable.grantReadWriteData(imageManagerFunction);
    // Grant read access to regional hubs table for multi-region AMI distribution
    props.regionalHubsTable.grantReadData(imageManagerFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(imageManagerFunction);
    }

    // Software Library Lambda function
    const softwareLibraryFunction = new lambda.Function(this, 'SoftwareLibraryFunction', {
      functionName: `${props.acronym.toLowerCase()}-software-library`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Software library management function',
      code: lambda.Code.fromAsset('lambda/software-library'),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        ...props.lambdaEnvironment,
        SOFTWARE_LIBRARY_TABLE_NAME: props.softwareLibraryTable.tableName,
        UPLOADS_BUCKET_NAME: props.imageBuilderUploadsBucket,
      },
      role: props.lambdaRole,
      timeout: cdk.Duration.minutes(1),
      reservedConcurrentExecutions: 5,
    });

    // Grant software library function access to its table
    props.softwareLibraryTable.grantReadWriteData(softwareLibraryFunction);

    // Grant S3 permissions for media uploads
    softwareLibraryFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [`arn:aws:s3:::${props.imageBuilderUploadsBucket}/software/*`],
    }));

    // Grant KMS permissions if encryption key is provided
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(softwareLibraryFunction);
    }

    const imageIntegration = new apigateway.LambdaIntegration(imageManagerFunction);
    const softwareLibraryIntegration = new apigateway.LambdaIntegration(softwareLibraryFunction);

    const imagesResource = props.api.root.addResource('images');
    imagesResource.addMethod('GET', imageIntegration, { authorizer });
    imagesResource.addMethod('POST', imageIntegration, { authorizer });

    // Image copy endpoint
    const imageCopyResource = imagesResource.addResource('copy');
    imageCopyResource.addMethod('POST', imageIntegration, { authorizer });

    const imageResource = imagesResource.addResource('{id}');
    imageResource.addMethod('PUT', imageIntegration, { authorizer });
    imageResource.addMethod('DELETE', imageIntegration, { authorizer });

    // Image Builder Pipeline endpoints
    const createPipelineResource = imagesResource.addResource('create-pipeline');
    createPipelineResource.addMethod('POST', imageIntegration, { authorizer });

    const pipelinesResource = imagesResource.addResource('pipelines');
    pipelinesResource.addMethod('GET', imageIntegration, { authorizer });

    const pipelineResource = pipelinesResource.addResource('{pipelineId}');
    pipelineResource.addMethod('PUT', imageIntegration, { authorizer });
    pipelineResource.addMethod('DELETE', imageIntegration, { authorizer });

    const pipelineStatusResource = pipelineResource.addResource('status');
    pipelineStatusResource.addMethod('GET', imageIntegration, { authorizer });

    const pipelineExecuteResource = pipelineResource.addResource('execute');
    pipelineExecuteResource.addMethod('POST', imageIntegration, { authorizer });

    // Software Library endpoints
    const softwareResource = imagesResource.addResource('software');
    softwareResource.addMethod('GET', softwareLibraryIntegration, { authorizer });
    softwareResource.addMethod('POST', softwareLibraryIntegration, { authorizer });

    // Upload URL endpoint for media files
    const uploadUrlResource = softwareResource.addResource('upload-url');
    uploadUrlResource.addMethod('POST', softwareLibraryIntegration, { authorizer });

    const softwareIdResource = softwareResource.addResource('{softwareId}');
    softwareIdResource.addMethod('GET', softwareLibraryIntegration, { authorizer });
    softwareIdResource.addMethod('PUT', softwareLibraryIntegration, { authorizer });
    softwareIdResource.addMethod('DELETE', softwareLibraryIntegration, { authorizer });

    // Install Script Agent endpoints (only if agent functions are available)
    if (props.invokeInstallScriptAgentFunction && props.installScriptProgressFunction && props.cancelInstallScriptFunction) {
      const invokeAgentIntegration = new apigateway.LambdaIntegration(props.invokeInstallScriptAgentFunction);
      const progressIntegration = new apigateway.LambdaIntegration(props.installScriptProgressFunction);
      const cancelIntegration = new apigateway.LambdaIntegration(props.cancelInstallScriptFunction);

      // POST /images/software/{softwareId}/generate-script
      const generateScriptResource = softwareIdResource.addResource('generate-script');
      generateScriptResource.addMethod('POST', invokeAgentIntegration, { authorizer });

      // GET /images/software/{softwareId}/generation-progress (SSE)
      const generationProgressResource = softwareIdResource.addResource('generation-progress');
      generationProgressResource.addMethod('GET', progressIntegration, { authorizer });

      // POST /images/software/{softwareId}/cancel-generation
      const cancelGenerationResource = softwareIdResource.addResource('cancel-generation');
      cancelGenerationResource.addMethod('POST', cancelIntegration, { authorizer });

      // Draft script generation endpoints (no softwareId required)
      // POST /images/software/generate-script-draft
      const generateScriptDraftResource = softwareResource.addResource('generate-script-draft');
      generateScriptDraftResource.addMethod('POST', invokeAgentIntegration, { authorizer });

      // GET /images/software/generation-progress-draft
      const generationProgressDraftResource = softwareResource.addResource('generation-progress-draft');
      generationProgressDraftResource.addMethod('GET', progressIntegration, { authorizer });

      // POST /images/software/cancel-generation - Cancel draft generation by executionId
      const cancelGenerationDraftResource = softwareResource.addResource('cancel-generation');
      cancelGenerationDraftResource.addMethod('POST', cancelIntegration, { authorizer });
    }

    // Chat Requirements endpoint (only when Bedrock features are enabled)
    if (props.chatRequirementsFunction) {
      const chatRequirementsIntegration = new apigateway.LambdaIntegration(props.chatRequirementsFunction);
      const chatResource = softwareResource.addResource('chat');
      chatResource.addMethod('POST', chatRequirementsIntegration, { authorizer });
    }
  }
}
