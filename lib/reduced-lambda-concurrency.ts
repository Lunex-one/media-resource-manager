// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IAspect, Token } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';

/**
 * Lowers every function's reserved concurrency so the stacks fit a region at the default quota.
 *
 * The stacks reserve about 1,450 concurrent executions between them. A region's default Lambda
 * quota is 1,000, and AWS keeps 100 of that unreserved, so at most 900 can be reserved before a
 * quota increase. Applied with reducedLambdaConcurrency=true, this halves each reservation, rounding
 * up, but never takes one below FLOOR, which brings the total to about 870. A reservation already at
 * or below FLOOR is left as it is, so the single-concurrency functions stay at 1.
 *
 * It is a deployment option, not a new default: deploying again without the flag restores the
 * values the stacks declare, which needs the quota raised first or CloudFormation rejects the
 * update. Halving the workstation create and start functions from 20 to 10 is the throughput this
 * gives up; requests beyond it are throttled and retried.
 *
 * Templates the regional hub generator builds (lambda/generate-regional-hub-template) are not CDK
 * constructs and are not changed by this.
 */
export class ReducedLambdaConcurrency implements IAspect {
  /** No reservation is lowered below this. */
  static readonly FLOOR = 5;

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) {
      return;
    }
    const reserved = node.reservedConcurrentExecutions;
    if (reserved === undefined || Token.isUnresolved(reserved) || reserved <= ReducedLambdaConcurrency.FLOOR) {
      return;
    }
    node.reservedConcurrentExecutions = Math.max(ReducedLambdaConcurrency.FLOOR, Math.ceil(reserved / 2));
  }
}
