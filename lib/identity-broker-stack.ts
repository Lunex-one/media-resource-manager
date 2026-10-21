// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const REALM = 'studio';
const CLIENT_ID = 'lunex-auth';
const BIND_ACCOUNT = 'svc-keycloak';
// Directory groups that reach the `groups` claim; the relying party maps them to roles.
const ROLE_GROUPS = ['AssistantEditors', 'AWS Delegated Administrators'];

export interface IdentityBrokerStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  /** The VPC the directory lives in. Tasks and the database use its private subnets, the load balancer its public ones. */
  vpc: ec2.IVpc;
  /** Public hostname of the broker, for example staging.idp.example.com. */
  hostname: string;
  /** ACM certificate for `hostname`, in this stack's region. */
  certificateArn: string;
  /** Mail domain of the directory users who may sign in through the broker. */
  mailDomain: string;
  /** Redirect URI of the relying party that signs users in through the broker. */
  redirectUri: string;
  /** DNS name of the directory, for example studio.mrm.internal. */
  directoryDomainName: string;
  /** Directory NetBIOS name, which names the OU holding the users. Defaults to the first DNS label. */
  directoryNetbiosName?: string;
  keycloakImage: string;
}

/**
 * Keycloak as an OpenID Connect provider in front of the MRM directory.
 *
 * Users and groups are read from the directory over LDAP (read only) and every sign-in is a bind
 * against it, so the broker and MRM authenticate the same accounts with the same passwords. The
 * subject claim `ad_guid` is the directory objectGUID, which survives a rebuild of Keycloak.
 *
 * Only /realms/* and /resources/* are routed from the internet. The admin console is reached
 * through ECS Exec or SSM port forwarding, and the realm file is applied on the first boot only
 * (Keycloak skips a realm that exists), so later realm changes are made in the admin console.
 */
export class IdentityBrokerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IdentityBrokerStackProps) {
    super(scope, id, {
      ...props,
      description: 'Keycloak OIDC provider with LDAP federation to the MRM directory',
    });

    const p = (name: string) => `/${props.pascalCaseName}${name}`;
    const privateSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const publicSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PUBLIC };

    // ------------------------------------------------------------------ secrets
    // Created by hand with the directory account: {"username","password"}.
    const bindCredentials = secretsmanager.Secret.fromSecretNameV2(
      this, 'BindCredentials', p('/Identity/KeycloakBindCredentials'));
    const bootstrapAdmin = new secretsmanager.Secret(this, 'BootstrapAdmin', {
      secretName: p('/IdentityBroker/BootstrapAdmin'),
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'kcadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
    // Entered into the relying party's connection settings.
    const clientSecret = new secretsmanager.Secret(this, 'AuthClientSecret', {
      secretName: p('/IdentityBroker/AuthClientSecret'),
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    // ----------------------------------------------------------------- database
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc, description: 'Keycloak tasks',
    });
    const databaseSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc, description: 'Keycloak database', allowAllOutbound: false,
    });
    databaseSg.addIngressRule(serviceSg, ec2.Port.tcp(5432), 'Keycloak tasks');

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: privateSubnets,
      securityGroups: [databaseSg],
      databaseName: 'keycloak',
      credentials: rds.Credentials.fromGeneratedSecret('keycloak', {
        secretName: p('/IdentityBroker/DatabaseCredentials'),
      }),
      allocatedStorage: 20,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // ---------------------------------------------------------------- container
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // The realm file is written at start with the credentials substituted, using bash built-ins
    // only. Keycloak skips the import when the realm already exists.
    const startScript = [
      'set -euo pipefail',
      'mkdir -p /opt/keycloak/data/import',
      'realm="$REALM_TEMPLATE"',
      'realm="${realm//__BIND_PASSWORD__/$KEYCLOAK_BIND_PASSWORD}"',
      'realm="${realm//__AUTH_CLIENT_SECRET__/$AUTH_CLIENT_SECRET}"',
      'realm="${realm//__MAIL_DOMAIN__/$MAIL_DOMAIN}"',
      'printf "%s" "$realm" > /opt/keycloak/data/import/studio-realm.json',
      'exec /opt/keycloak/bin/kc.sh start --import-realm',
    ].join('\n');

    taskDefinition.addContainer('keycloak', {
      image: ecs.ContainerImage.fromRegistry(props.keycloakImage),
      entryPoint: ['/bin/bash', '-c'],
      command: [startScript],
      portMappings: [{ containerPort: 8080 }],
      environment: {
        KC_DB: 'postgres',
        KC_DB_URL: `jdbc:postgresql://${database.dbInstanceEndpointAddress}:${database.dbInstanceEndpointPort}/keycloak?sslmode=require`,
        KC_HOSTNAME: `https://${props.hostname}`,
        // The admin console is reached by port forwarding, never through the load balancer.
        KC_HOSTNAME_ADMIN: 'http://localhost:8080',
        KC_HTTP_ENABLED: 'true', // TLS ends at the load balancer
        KC_PROXY_HEADERS: 'xforwarded',
        KC_HEALTH_ENABLED: 'true',
        MAIL_DOMAIN: props.mailDomain,
        REALM_TEMPLATE: JSON.stringify(buildRealm(props)),
      },
      secrets: {
        KC_DB_USERNAME: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        KC_DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        KC_BOOTSTRAP_ADMIN_USERNAME: ecs.Secret.fromSecretsManager(bootstrapAdmin, 'username'),
        KC_BOOTSTRAP_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(bootstrapAdmin, 'password'),
        KEYCLOAK_BIND_PASSWORD: ecs.Secret.fromSecretsManager(bindCredentials, 'password'),
        AUTH_CLIENT_SECRET: ecs.Secret.fromSecretsManager(clientSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'keycloak', logGroup }),
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      // One task: never run two Keycloaks against the same database during a rollout.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      securityGroups: [serviceSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      // Keycloak builds on start and then imports the realm, which takes minutes.
      healthCheckGracePeriod: cdk.Duration.minutes(6),
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
    });

    // ------------------------------------------------------------ load balancer
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc, description: 'Identity broker load balancer',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP, redirected to HTTPS');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: publicSubnets,
      securityGroup: albSg,
      dropInvalidHeaderFields: true,
    });
    const accessLogs = new s3.Bucket(this, 'AlbAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    alb.logAccessLogs(accessLogs, 'identity-broker');

    alb.addListener('Http', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    });
    const https = alb.addListener('Https', {
      port: 443,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not found',
      }),
    });
    // Only the public OIDC paths. /admin and everything else stay unreachable from the internet.
    https.addTargets('Keycloak', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/realms/*', '/resources/*'])],
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/realms/master',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    // --------------------------------------------------------------------- WAF
    const metric = (name: string) => `${props.acronym}IdentityBroker${name}`;
    const visibility = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName: metric(name),
    });
    const uriContains = (text: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        searchString: text,
        fieldToMatch: { uriPath: {} },
        textTransformations: [{ priority: 0, type: 'NONE' }],
        positionalConstraint: 'CONTAINS',
      },
    });
    // The managed groups start in count mode so they cannot block the relying party's
    // server-side token calls; review the metrics, then switch them to block.
    const managedGroup = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { count: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: visibility(name),
    });
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('WebAcl'),
      rules: [
        {
          name: 'LoginRateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 100,
              evaluationWindowSec: 300,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                orStatement: {
                  statements: [uriContains('/login-actions/'), uriContains('/protocol/openid-connect/token')],
                },
              },
            },
          },
          visibilityConfig: visibility('LoginRateLimit'),
        },
        managedGroup('AWSManagedRulesCommonRuleSet', 10),
        managedGroup('AWSManagedRulesKnownBadInputsRuleSet', 20),
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ----------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'IssuerUrl', { value: `https://${props.hostname}/realms/${REALM}` });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: `Point a CNAME for ${props.hostname} at this`,
    });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'AuthClientSecretName', {
      value: clientSecret.secretName,
      description: `Client secret for client ${CLIENT_ID}, entered in the relying party's connection`,
    });

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-RDS3', reason: 'Single instance: Keycloak runs one task and the realm is rebuilt from the directory. Enable Multi-AZ for production.' },
      { id: 'AwsSolutions-RDS6', reason: 'Keycloak connects to its database with the generated secret; IAM database authentication is not configured.' },
      { id: 'AwsSolutions-RDS11', reason: 'The database is private and reachable only from the Keycloak tasks security group.' },
      { id: 'AwsSolutions-SMG4', reason: 'The bootstrap admin and client secret are not rotated automatically; database secret rotation is a follow-up.' },
      { id: 'AwsSolutions-EC23', reason: 'The load balancer is the public OIDC endpoint, intentionally open on 443 and on 80 for the redirect.' },
      { id: 'AwsSolutions-ECS2', reason: 'Only non-secret settings are plain environment variables; every credential comes from Secrets Manager.' },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcards come from ECS Exec and the CDK-generated ECS, image and log permissions.' },
      { id: 'AwsSolutions-S1', reason: 'This bucket is the load balancer access-log destination.' },
    ]);
  }
}

/** The realm applied on the first boot. Placeholders are substituted by the container start script. */
function buildRealm(props: IdentityBrokerStackProps) {
  const labels = props.directoryDomainName.split('.');
  const baseDn = labels.map((label) => `DC=${label}`).join(',');
  const usersDn = `OU=Users,OU=${props.directoryNetbiosName ?? labels[0]},${baseDn}`;
  const roleFilter = `(|${ROLE_GROUPS.map((group) => `(cn=${group})`).join('')})`;

  const attributeMapper = (name: string, ldapAttribute: string, userAttribute: string, mandatory: boolean) => ({
    name,
    providerId: 'user-attribute-ldap-mapper',
    config: {
      'ldap.attribute': [ldapAttribute],
      'user.model.attribute': [userAttribute],
      'is.mandatory.in.ldap': [String(mandatory)],
      'read.only': ['true'],
      'always.read.value.from.ldap': ['true'],
    },
  });

  return {
    realm: REALM,
    enabled: true,
    registrationAllowed: false,
    resetPasswordAllowed: false,
    sslRequired: 'external',
    // Five failures lock the user in Keycloak for 30 minutes, so repeated attempts cannot add
    // up to the directory's own lockout threshold.
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 5,
    maxDeltaTimeSeconds: 1800,
    waitIncrementSeconds: 1800,
    maxFailureWaitSeconds: 1800,
    components: {
      'org.keycloak.storage.UserStorageProvider': [{
        name: 'studio-ad',
        providerId: 'ldap',
        config: {
          vendor: ['ad'],
          connectionUrl: [`ldap://${props.directoryDomainName}:389`],
          bindDn: [`CN=${BIND_ACCOUNT},${usersDn}`],
          bindCredential: ['__BIND_PASSWORD__'],
          authType: ['simple'],
          useTruststoreSpi: ['never'],
          usersDn: [usersDn],
          searchScope: ['2'],
          editMode: ['READ_ONLY'],
          importEnabled: ['true'],
          syncRegistrations: ['false'],
          usernameLDAPAttribute: ['sAMAccountName'],
          rdnLDAPAttribute: ['cn'],
          uuidLDAPAttribute: ['objectGUID'],
          userObjectClasses: ['person, organizationalPerson, user'],
          // Enabled accounts with a mail address in the connection's domain, nobody else.
          customUserSearchFilter: ['(&(mail=*@__MAIL_DOMAIN__)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'],
          pagination: ['true'],
          fullSyncPeriod: ['86400'],
          changedSyncPeriod: ['900'],
        },
        subComponents: {
          'org.keycloak.storage.ldap.mappers.LDAPStorageMapper': [
            attributeMapper('username', 'sAMAccountName', 'username', true),
            attributeMapper('first name', 'givenName', 'firstName', false),
            attributeMapper('last name', 'sn', 'lastName', false),
            attributeMapper('email', 'mail', 'email', false),
            {
              name: 'MSAD account controls',
              providerId: 'msad-user-account-control-mapper',
              config: { 'ldap.password.policy.hints.enabled': ['false'] },
            },
            {
              name: 'groups',
              providerId: 'group-ldap-mapper',
              config: {
                'groups.dn': [baseDn],
                'group.name.ldap.attribute': ['cn'],
                'group.object.classes': ['group'],
                'membership.ldap.attribute': ['member'],
                'membership.attribute.type': ['DN'],
                'user.roles.retrieve.strategy': ['LOAD_GROUPS_BY_MEMBER_ATTRIBUTE'],
                mode: ['READ_ONLY'],
                'preserve.group.inheritance': ['false'],
                'groups.ldap.filter': [roleFilter],
              },
            },
          ],
        },
      }],
    },
    clients: [{
      clientId: CLIENT_ID,
      protocol: 'openid-connect',
      publicClient: false,
      secret: '__AUTH_CLIENT_SECRET__',
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: [props.redirectUri],
      webOrigins: [new URL(props.redirectUri).origin],
      attributes: { 'pkce.code.challenge.method': 'S256' },
      protocolMappers: [
        {
          name: 'groups',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-group-membership-mapper',
          config: {
            'claim.name': 'groups',
            'full.path': 'false',
            'id.token.claim': 'true',
            'access.token.claim': 'true',
            'userinfo.token.claim': 'true',
          },
        },
        {
          // The directory objectGUID, the stable subject of the relying party's connection.
          name: 'ad_guid',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-attribute-mapper',
          config: {
            'user.attribute': 'LDAP_ID',
            'claim.name': 'ad_guid',
            'jsonType.label': 'String',
            'id.token.claim': 'true',
            'access.token.claim': 'true',
            'userinfo.token.claim': 'true',
          },
        },
      ],
    }],
  };
}
