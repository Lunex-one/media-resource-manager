// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { createHandler } = require('./handler');

const SECRET_TTL_MS = 5 * 60 * 1000;
let cachedSecret = null;
let secretExpiry = 0;
let lambdaClient = null;
let secretsClient = null;

/** The session-signing secret, cached for a few minutes. */
async function getSecret() {
  const now = Date.now();
  if (cachedSecret && now < secretExpiry) return cachedSecret;
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  secretsClient = secretsClient || new SecretsManagerClient();
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.SESSION_SECRET_ARN }));
  cachedSecret = response.SecretString;
  secretExpiry = now + SECRET_TTL_MS;
  return cachedSecret;
}

/** Invoke one of MRM's Lambdas and return its parsed API-Gateway-style response. */
async function invoke(functionName, payload) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  lambdaClient = lambdaClient || new LambdaClient();
  const response = await lambdaClient.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  if (response.FunctionError) throw new Error(`${functionName} returned ${response.FunctionError}`);
  if (!response.Payload) throw new Error(`${functionName} returned no payload`);
  return JSON.parse(Buffer.from(response.Payload).toString('utf8'));
}

exports.handler = createHandler({
  getSecret,
  invoke,
  functions: {
    ldapAuth: process.env.LDAP_AUTH_FUNCTION_NAME,
    workstationManager: process.env.WORKSTATION_MANAGER_FUNCTION_NAME,
    dcvSessionManager: process.env.DCV_SESSION_MANAGER_FUNCTION_NAME,
  },
});
