// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the terminated-workstation self-heal in
 * lambda/workstation-manager/index.js.
 *
 * getWorkstations enriches each record with live EC2 status and, on finding an instance
 * terminated, writes that back to DynamoDB. The write is fire-and-forget and was issued with no
 * ConditionExpression, so when it raced DELETE /workstations/{id} it re-created the record that
 * delete had just removed - UpdateItem creates the item when it is absent.
 *
 * The resurrected row is a stub. It carries only the attributes the update sets, so it has no
 * createdAt, platform, region, workstationName or amiId, and it lists for ever as a Terminated
 * workstation whose instance does not exist. Nothing clears it either: the enrichment skips any
 * row already reading terminated, so it is never described against EC2 again.
 *
 * Five such rows were found in the eu-central-1 deployment on 2026-09-15, each holding exactly
 * five to seven attributes against 27 on a live record, and two of them sharing an updatedAt to
 * the millisecond - one list request's self-heal loop writing both in the same pass.
 *
 * lambda/ec2-state-handler/index.js guards the identical write with attribute_exists(instanceId);
 * this locks in the same guard here.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { terminatedSelfHealParams } = require('../lambda/workstation-manager/self-heal.js');

const TABLE = 'mrm-workstations';
const INSTANCE = 'i-021543e8193513365';
const AT = new Date('2026-09-11T19:13:02.427Z');

describe('terminatedSelfHealParams', () => {
  it('refuses to create a record that is no longer there', () => {
    const params = terminatedSelfHealParams(TABLE, INSTANCE, AT);
    expect(params.ConditionExpression).toBe('attribute_exists(instanceId)');
  });

  it('addresses the record by instance id, on the workstation table', () => {
    const params = terminatedSelfHealParams(TABLE, INSTANCE, AT);
    expect(params.TableName).toBe(TABLE);
    expect(params.Key).toEqual({ instanceId: INSTANCE });
  });

  it('still writes exactly what it wrote before the guard was added', () => {
    const params = terminatedSelfHealParams(TABLE, INSTANCE, AT);
    expect(params.UpdateExpression).toBe(
      'SET instanceStatus = :ist, #status = :wst, dcvStatus = :dcv, updatedAt = :ts '
      + 'REMOVE dcvSessionId, sessionState'
    );
    expect(params.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(params.ExpressionAttributeValues).toEqual({
      ':ist': 'terminated',
      ':wst': 'Terminated',
      ':dcv': 'stopped',
      ':ts': '2026-09-11T19:13:02.427Z'
    });
  });

  it('sets only the four attributes that a resurrected stub was found to carry', () => {
    // This is the shape the deployment turned up: instanceId from the key, plus these four and
    // nothing else. It is here so that anyone widening the SET list sees why the guard matters.
    const params = terminatedSelfHealParams(TABLE, INSTANCE, AT);
    expect(Object.keys(params.ExpressionAttributeValues).sort())
      .toEqual([':dcv', ':ist', ':ts', ':wst']);
  });
});
