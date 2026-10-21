// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

/**
 * Keeps a workstation build from writing back a record that DELETE /workstations/{id} removed.
 *
 * The creation state machines write progress onto the workstation record with DynamoDB
 * UpdateItem. UpdateItem creates the item when it is absent, so a build that carried on after its
 * workstation was deleted re-created the record as a stub holding only the attributes that one
 * update sets: no createdAt, platform, region or workstationName.
 *
 * The record is always created before the first of these writes, by the instance-create-* Lambda
 * that is each machine's first state, so every write here can require it to exist. When it does
 * not, the write fails with ConditionalCheckFailedException and the build ends in one Fail state
 * that says why, instead of driving an instance that is already terminated.
 *
 * lambda/ec2-state-handler/index.js and lambda/workstation-manager/self-heal.js guard their writes
 * to the same record with the same condition.
 */
export class WorkstationRecordGuard {
  /** Require the record to exist, so an update cannot re-create a deleted one. */
  static readonly CONDITION = 'attribute_exists(instanceId)';

  /**
   * The error a failed condition raises in a CallAwsService task. AWS SDK integrations name their
   * errors `<ServiceName>.<ErrorName>` with the SDK exception prefix, which for DynamoDB is
   * `DynamoDb`; the optimized dynamodb:updateItem integration would say `DynamoDB` instead.
   */
  static readonly RECORD_GONE_ERROR = 'DynamoDb.ConditionalCheckFailedException';

  /** The state a build ends in when its workstation was deleted while it ran. */
  readonly deleted: stepfunctions.Fail;

  constructor(scope: Construct) {
    this.deleted = new stepfunctions.Fail(scope, 'WorkstationDeletedDuringBuild', {
      error: 'WorkstationDeletedDuringBuild',
      cause: 'The workstation record was deleted while the build was running, so the build stops '
        + 'instead of writing the record back',
    });
  }

  /** Route a guarded write's failed condition to the `deleted` state. Returns the task. */
  protect(task: tasks.CallAwsService): tasks.CallAwsService {
    task.addCatch(this.deleted, {
      errors: [WorkstationRecordGuard.RECORD_GONE_ERROR],
      resultPath: stepfunctions.JsonPath.DISCARD,
    });
    return task;
  }
}
