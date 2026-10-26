// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The reduced reserved-concurrency option, for a region at the default Lambda quota.
 *
 * With reducedLambdaConcurrency=true, bin/media-resource-manager.ts adds ReducedLambdaConcurrency
 * to the app. Each reservation is halved, rounding up, but never taken below 5; one at or below 5
 * is kept, and a function with no reservation keeps none.
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { ReducedLambdaConcurrency } from '../lib/reduced-lambda-concurrency';

/** Every reservation the stacks declare, and what the option lowers it to. */
const EXPECTED: [number, number][] = [
  [1, 1],
  [5, 5],
  [10, 5],
  [15, 8],
  [20, 10],
  [25, 13],
];

/** A stack with one function per declared reservation, plus one without. */
function synth(reduced: boolean): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Functions');
  const fn = (id: string, reservedConcurrentExecutions?: number) => new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
    reservedConcurrentExecutions,
  });
  for (const [declared] of EXPECTED) {
    fn(`Reserved${declared}`, declared);
  }
  fn('Unreserved');
  if (reduced) {
    cdk.Aspects.of(app).add(new ReducedLambdaConcurrency());
  }
  return Template.fromStack(stack);
}

/** Reserved concurrency by function logical id, with null for none. */
function reservations(template: Template): Record<string, number | null> {
  const functions = template.findResources('AWS::Lambda::Function');
  return Object.fromEntries(Object.entries(functions).map(
    ([id, resource]) => [id, resource.Properties.ReservedConcurrentExecutions ?? null]));
}

describe('ReducedLambdaConcurrency', () => {
  test('halves each reservation, rounding up, never below 5', () => {
    const reduced = reservations(synth(true));
    for (const [declared, lowered] of EXPECTED) {
      const id = Object.keys(reduced).find((key) => key.startsWith(`Reserved${declared}`))!;
      expect(reduced[id]).toBe(lowered);
    }
  });

  test('leaves a function without a reservation unreserved', () => {
    const reduced = reservations(synth(true));
    const id = Object.keys(reduced).find((key) => key.startsWith('Unreserved'))!;
    expect(reduced[id]).toBeNull();
  });

  test('changes nothing when it is not applied', () => {
    const declared = reservations(synth(false));
    for (const [value] of EXPECTED) {
      const id = Object.keys(declared).find((key) => key.startsWith(`Reserved${value}`))!;
      expect(declared[id]).toBe(value);
    }
  });
});
