// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');
const { adBindCode, adBindReason, REASON_MESSAGES } = require('./bind-errors');
const { readUserAttributes, escapeLdapFilter } = require('./user-attributes');

const lambdaClient = new LambdaClient();
const dynamoDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Just-in-time provisioning of the `mrm-users` DDB record on successful LDAP
 * authentication. Mirrors the pattern Cognito uses for SAML-federated users
 * (record materialises on first sign-in) so admins never need to pre-sync a
 * potentially-huge AD group into DDB just to make users assignable.
 *
 * Idempotent: `createdAt` and manually-editable admin fields (department,
 * preferences) are preserved via `if_not_exists`. LDAP-owned fields (email,
 * firstName, lastName, isAdmin) are refreshed to LDAP truth on every login.
 * `lastLoginAt` is always updated so admins can see who is active.
 *
 * A DDB failure MUST NOT fail authentication - LDAP truth outranks the DDB
 * cache. Log and continue.
 */
async function upsertUserRecord({ username, email, firstName, lastName, isAdmin }) {
  const tableName = process.env.USER_TABLE_NAME;
  if (!tableName) {
    console.warn('USER_TABLE_NAME not configured; skipping JIT user upsert');
    return;
  }
  const now = new Date().toISOString();
  try {
    await dynamoDoc.send(new UpdateCommand({
      TableName: tableName,
      Key: { userId: username },
      UpdateExpression:
        'SET #email = :email, #firstName = :firstName, #lastName = :lastName, ' +
        '#isAdmin = :isAdmin, #lastLoginAt = :now, ' +
        '#createdAt = if_not_exists(#createdAt, :now), ' +
        '#preferences = if_not_exists(#preferences, :emptyMap)',
      ExpressionAttributeNames: {
        '#email': 'email',
        '#firstName': 'firstName',
        '#lastName': 'lastName',
        '#isAdmin': 'isAdmin',
        '#lastLoginAt': 'lastLoginAt',
        '#createdAt': 'createdAt',
        '#preferences': 'preferences',
      },
      ExpressionAttributeValues: {
        ':email': email || '',
        ':firstName': firstName || '',
        ':lastName': lastName || '',
        ':isAdmin': !!isAdmin,
        ':now': now,
        ':emptyMap': {},
      },
    }));
    console.log(`JIT user record upserted for ${username} (isAdmin=${!!isAdmin})`);
  } catch (err) {
    // Never fail auth on cache write. Downstream impact is only that the
    // user does not appear in the admin listing until their next sign-in.
    console.warn(`JIT user upsert failed for ${username}: ${err.name} ${err.message}`);
  }
}

// Cache the secret to avoid repeated API calls
let cachedSecret = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getJwtSecret() {
    const now = Date.now();
    if (cachedSecret && now < cacheExpiry) {
        return cachedSecret;
    }

    const client = new SecretsManagerClient();
    const command = new GetSecretValueCommand({
        SecretId: process.env.JWT_SECRET_ARN
    });
    const response = await client.send(command);
    cachedSecret = response.SecretString;
    cacheExpiry = now + CACHE_TTL;
    return cachedSecret;
}

// Simple JWT implementation
async function createJWT(payload) {
    const secret = await getJwtSecret();
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret)
        .update(encodedHeader + '.' + encodedPayload)
        .digest('base64url');
    return encodedHeader + '.' + encodedPayload + '.' + signature;
}

// Direct LDAP authentication with group checking
async function authenticateWithLDAP(username, password) {
  const { Client } = require('ldapts');
  const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

  // Get domain name from SSM Parameter Store
  let domainName = 'studio.mrm.internal'; // fallback
  try {
    const response = await new SSMClient().send(new GetParameterCommand({
      Name: `/${process.env.PASCAL_CASE_NAME}/Identity/ActiveDirectoryDomainName`,
    }));
    domainName = response.Parameter.Value;
    console.log('Retrieved domain from SSM:', domainName);
  } catch (error) {
    console.error('Failed to get domain name from SSM, using fallback:', error.message);
  }

  console.log('Starting LDAP authentication for:', username);
  const client = new Client({
    url: `ldap://${domainName}:389`,
    timeout: 10000,
    connectTimeout: 10000,
    strictDN: false, // the bind name is a UPN, not a DN
  });
  const userDN = username.includes('@') ? username : `${username}@${domainName}`;
  const baseDN = domainName.split('.').map((part) => `DC=${part}`).join(',');

  const signIn = async () => {
    try {
      await client.bind(userDN, password);
    } catch (err) {
      // ldapts keeps the directory's diagnostic on the error, so the sub-code can be read.
      const adCode = adBindCode(err);
      console.log(`LDAP bind failed: ${err.message}${adCode ? ` (AD data ${adCode})` : ''}`);
      return { success: false, reason: adBindReason(adCode) };
    }

    console.log('LDAP bind successful, reading the user entry');
    // A search failure after a good bind still signs the user in, with defaults: the directory's
    // word that the password is right outranks the profile lookup.
    let profile = readUserAttributes(null, username, domainName);
    try {
      const { searchEntries } = await client.search(baseDN, {
        filter: `(&(objectClass=user)(sAMAccountName=${escapeLdapFilter(username)}))`,
        scope: 'sub',
        attributes: ['*'],
      });
      profile = readUserAttributes(searchEntries[0], username, domainName);
      console.log('Final admin status:', profile.isAdmin);
    } catch (searchError) {
      console.log('LDAP search failed:', searchError.message);
    }
    return { success: true, ...profile };
  };

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.log('LDAP timeout');
      resolve({ success: false });
    }, 15000);
  });
  try {
    return await Promise.race([signIn(), deadline]);
  } catch (clientError) {
    console.log('LDAP client error:', clientError.message);
    return { success: false };
  } finally {
    clearTimeout(timer);
    await client.unbind().catch(() => {});
  }
}

        exports.handler = async (event) => {
          const rawBody = JSON.parse(event.body || '{}');
          // Normalise UPN ("user@domain.tld") and down-level ("DOMAIN\user")
          // forms into a bare sAMAccountName. The LDAP search filter below
          // binds on sAMAccountName only, so the non-canonical forms would
          // otherwise silently fail to match despite being valid AD
          // identifiers. Frontend also strips defensively; doing it here
          // covers direct API callers (curl, integration tests, other
          // clients) too.
          const rawUsername = rawBody.username;
          const username = typeof rawUsername === 'string'
            ? rawUsername.trim().replace(/^[^\\]+\\/, '').replace(/@.+$/, '')
            : rawUsername;
          const password = rawBody.password;
          console.log('Direct LDAP Auth request for user:', username, rawUsername !== username ? `(normalised from "${rawUsername}")` : '');

          if (!username || !password) {
            return {
              statusCode: 400,
              headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Headers': 'Content-Type'
              },
              body: JSON.stringify({ error: 'Username and password required' })
            };
          }
          
          try {
            // Use direct LDAP authentication with group checking
            const ldapResult = await authenticateWithLDAP(username, password);
            
            if (ldapResult.success) {
              // JIT-provision the mrm-users DDB record so this user appears
              // in the admin listing and can be assigned to workstations. Runs
              // before the JWT is minted but never fails auth - see
              // upsertUserRecord() for the "log and continue" contract.
              await upsertUserRecord({
                username,
                email: ldapResult.email,
                firstName: ldapResult.firstName,
                lastName: ldapResult.lastName,
                isAdmin: ldapResult.isAdmin,
              });

              // Create JWT token with proper admin status from AD groups
              const payload = {
                username: username,
                email: ldapResult.email || username + '@studio.mcs.internal',
                given_name: ldapResult.firstName || ldapResult.displayName || username,
                family_name: ldapResult.lastName || '',
                isAdmin: ldapResult.isAdmin || false,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
              };
              
              const token = await createJWT(payload);
              
              return {
                statusCode: 200,
                headers: { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Headers': 'Content-Type'
                },
                body: JSON.stringify({ 
                  success: true, 
                  message: 'LDAP authentication successful',
                  username: username,
                  token: token
                })
              };
            } else {
              return {
                statusCode: 401,
                headers: { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Credentials': 'true',
                  'Access-Control-Allow-Headers': 'Content-Type'
                },
                body: JSON.stringify(
                    ldapResult.reason
                      ? { error: REASON_MESSAGES[ldapResult.reason], code: ldapResult.reason }
                      : { error: 'Invalid credentials' }
                  )
              };
            }
          } catch (error) {
            console.error('Authentication error:', error);
            return {
              statusCode: 500,
              headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Headers': 'Content-Type'
              },
              body: JSON.stringify({ error: 'Internal server error' })
            };
          }
        };