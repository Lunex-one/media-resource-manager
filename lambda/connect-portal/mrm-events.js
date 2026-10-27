// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

/**
 * Builds the events the portal sends to MRM's Lambdas. They are invoked directly, not through API
 * Gateway, so the authorizer's context has to be supplied here, in the shape the jwt-authorizer
 * stamps: string values, `isAdmin` as 'true' or 'false'.
 *
 * The identity comes only from the portal's own verified session. `isAdmin` is always 'false' on
 * purpose: the portal is where a person reaches their own machines, so even an administrator sees
 * only the workstations assigned to them. Administration stays in the MRM console.
 */

function authorizerContext(user) {
  return {
    username: user.username,
    userId: user.username,
    email: user.email || '',
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    isAdmin: 'false',
    tokenType: 'ldap',
  };
}

/** An API-Gateway-shaped event for one of MRM's Lambdas, acting as `user`. */
function mrmEvent({ method, path, body }, user) {
  return {
    httpMethod: method,
    path,
    headers: { 'Content-Type': 'application/json' },
    queryStringParameters: null,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: authorizerContext(user) },
  };
}

module.exports = { authorizerContext, mrmEvent };
