// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The DynamoDB update that marks a workstation record terminated.
//
// It lives in its own module, importing nothing, so that the shape of the write can be unit
// tested the way lambda/instance-create-linux/linux-distro.js is. Nothing else here needs a
// module of its own; this one earns it because of the ConditionExpression below.
//
// **The ConditionExpression is the whole point.** DynamoDB's UpdateItem creates the item when it
// is absent, so an unguarded self-heal that races DELETE /workstations/{id} writes back the row
// that delete had just removed. What comes back is not the old record. It is a stub carrying only
// the four attributes set here, with no createdAt, platform, region, workstationName or amiId,
// because those are written once by instance-create-* and never written again. The stub then
// lists for ever as a Terminated workstation whose instance does not exist, and no code path
// will ever clear it: the enrichment in getWorkstations skips any row that already reads
// terminated, so it is never described against EC2 and never logged again.
//
// Five such rows were found in the eu-central-1 deployment on 2026-09-15 -
// i-021543e8193513365, i-0bcd4f04e5be85a89, i-0388ccfd90a2e6b8c, i-091adebd385846c5d and
// i-04a0a779be7b16527 - each holding exactly these attributes and nothing else, against 27 on a
// live record. Two of them carry the same updatedAt to the millisecond, which is one list
// request's self-heal loop writing both in the same pass.
//
// lambda/ec2-state-handler/index.js already guards the identical write this way.

function terminatedSelfHealParams(tableName, instanceId, now = new Date()) {
  return {
    TableName: tableName,
    Key: { instanceId },
    UpdateExpression: 'SET instanceStatus = :ist, #status = :wst, dcvStatus = :dcv, updatedAt = :ts REMOVE dcvSessionId, sessionState',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':ist': 'terminated',
      ':wst': 'Terminated',
      ':dcv': 'stopped',
      ':ts': now.toISOString(),
    },
    // Heal this record only if it is still there. Without this the write is an upsert.
    ConditionExpression: 'attribute_exists(instanceId)',
  };
}

module.exports = { terminatedSelfHealParams };
