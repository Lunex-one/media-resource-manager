// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ConnectPortalStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  /** Public hostname. Optional: without it the portal is served on its CloudFront address. */
  hostname?: string;
  /** ACM certificate for `hostname`, in us-east-1 (a CloudFront requirement). Required with a hostname. */
  certificateArn?: string;
}

/**
 * A place users come back to in order to reach their own workstations.
 *
 * One CloudFront distribution serves static pages from S3 and routes /api/* to a small Lambda
 * (lambda/connect-portal) over an IAM-authenticated function URL, so the Lambda is reachable only
 * through CloudFront and the WAF rate limit on sign-in cannot be bypassed. The Lambda signs users in
 * through MRM's ldap-auth and then invokes MRM's workstation-manager and dcv-session-manager
 * directly, always as the signed-in user and never as an administrator. A stable
 * /connect/<instanceId> link signs in, starts the machine if needed, waits, and opens the desktop.
 *
 * Same origin means no CORS: the page and its API share a hostname.
 */
export class ConnectPortalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConnectPortalStackProps) {
    super(scope, id, { ...props, description: 'Connect portal: one place for users to reach their workstations' });

    if (!cdk.Token.isUnresolved(this.region) && this.region !== 'us-east-1') {
      throw new Error('The connect portal uses a CloudFront web ACL, which must be in us-east-1.');
    }
    if (!!props.hostname !== !!props.certificateArn) {
      throw new Error('connectPortalHostname and connectPortalCertificateArn must be set together.');
    }

    const p = (name: string) => `/${props.pascalCaseName}${name}`;
    const prefix = props.acronym.toLowerCase();
    const functionArn = (suffix: string) =>
      `arn:aws:lambda:${this.region}:${this.account}:function:${prefix}-${suffix}`;

    // ------------------------------------------------------------------ storage
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // CloudFront standard logging writes with ACLs.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --------------------------------------------------------------- the API
    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      secretName: p('/ConnectPortal/SessionSecret'),
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const portalFunction = new lambda.Function(this, 'PortalFunction', {
      functionName: `${prefix}-connect-portal`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/connect-portal')),
      // A cold start of the desktop-session Lambda inside the VPC can take a while.
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: 20,
      logGroup: new logs.LogGroup(this, 'PortalLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        SESSION_SECRET_ARN: sessionSecret.secretArn,
        LDAP_AUTH_FUNCTION_NAME: `${prefix}-ldap-auth`,
        WORKSTATION_MANAGER_FUNCTION_NAME: `${prefix}-workstation-manager`,
        DCV_SESSION_MANAGER_FUNCTION_NAME: `${prefix}-dcv-session-manager`,
      },
    });
    sessionSecret.grantRead(portalFunction);
    portalFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [functionArn('ldap-auth'), functionArn('workstation-manager'), functionArn('dcv-session-manager')],
    }));
    const functionUrl = portalFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // -------------------------------------------------------------------- WAF
    const wafMetric = (name: string) => `${props.acronym}ConnectPortal${name}`;
    const uriEquals = (text: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        searchString: text,
        fieldToMatch: { uriPath: {} },
        textTransformations: [{ priority: 0, type: 'NONE' }],
        positionalConstraint: 'EXACTLY',
      },
    });
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: wafMetric('WebAcl') },
      // The same {error, code} shape the sign-in page already displays.
      customResponseBodies: {
        RateLimited: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify({
            error: 'Too many sign-in attempts. Wait a few minutes and try again.',
            code: 'RATE_LIMITED',
          }),
        },
      },
      rules: [{
        name: 'SignInRateLimit',
        priority: 1,
        action: { block: { customResponse: { responseCode: 429, customResponseBodyKey: 'RateLimited' } } },
        statement: {
          rateBasedStatement: {
            limit: 20,
            evaluationWindowSec: 300,
            aggregateKeyType: 'IP',
            scopeDownStatement: {
              andStatement: {
                statements: [
                  uriEquals('/api/login'),
                  {
                    byteMatchStatement: {
                      searchString: 'POST',
                      fieldToMatch: { method: {} },
                      textTransformations: [{ priority: 0, type: 'NONE' }],
                      positionalConstraint: 'EXACTLY',
                    },
                  },
                ],
              },
            },
          },
        },
        visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: wafMetric('SignInRateLimit') },
      }],
    });

    // ------------------------------------------------------------- CloudFront
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy:
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
            "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER },
      },
    });

    // Any path that is not a file is a page route (/connect/<id>): serve the app. Attached to the
    // page behavior only, so errors from /api/* are not rewritten.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        'function handler(event) {\n' +
        '  var request = event.request;\n' +
        '  var uri = request.uri;\n' +
        "  if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) { request.uri = '/index.html'; }\n" +
        '  return request;\n' +
        '}'
      ),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.acronym} connect portal`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // A function URL needs its own Host header, so everything else is forwarded, cookies included.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
        },
      },
      ...(props.hostname && props.certificateArn
        ? {
            domainNames: [props.hostname],
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn),
          }
        : {}),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: webAcl.attrArn,
      enableLogging: true,
      logBucket,
      logFilePrefix: 'connect-portal/',
    });

    // Newer function URLs need both invoke permissions for an IAM-authenticated CloudFront origin.
    portalFunction.addPermission('CloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    });

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../connect-portal/web'))],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      waitForDistributionInvalidation: false,
    });

    // ---------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'PortalUrl', {
      value: props.hostname ? `https://${props.hostname}` : `https://${distribution.distributionDomainName}`,
      description: 'Where users reach their workstations',
    });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: props.hostname ? `Point a CNAME for ${props.hostname} at this` : 'The portal address',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'AWS managed policies are the standard execution roles for the functions and the deployment custom resources.' },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcards come from the S3 deployment and auto-delete custom resources and the CDK-generated log permissions.' },
      { id: 'AwsSolutions-L1', reason: 'The CDK-managed deployment and auto-delete custom resources choose their own runtime.' },
      { id: 'AwsSolutions-S1', reason: 'The web bucket holds only the public static pages; the CloudFront access log bucket is itself the log destination.' },
      { id: 'AwsSolutions-SMG4', reason: 'The session-signing secret is rotated by changing it; sessions last eight hours.' },
      { id: 'AwsSolutions-CFR1', reason: 'Access is controlled by sign-in; geo restriction is not required.' },
      { id: 'AwsSolutions-CFR4', reason: 'TLS 1.2 is the minimum once a custom domain and certificate are configured; the default CloudFront certificate is for testing.' },
    ]);
  }
}
