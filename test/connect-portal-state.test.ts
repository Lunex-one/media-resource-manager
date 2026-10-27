// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What state the connect portal shows for a workstation, and what it offers.
 *
 * The rule is the MRM console's: a machine is ready only when its instance is running AND its DCV
 * agent says ready. Before that the page holds the workflow step MRM reports, so a machine that has
 * just been told to start reads "Starting instance" and not "Stopped", and one whose instance is up
 * but whose desktop is not yet registered reads "Starting desktop" and not "Running". Connect on
 * such a machine used to answer "Almost ready…" indefinitely.
 */

export {};

const { describe: describeState, toDcvUrl, WORKFLOW_LABELS } = require('../connect-portal/web/state.js');

type Workstation = { instanceStatus?: string; status?: string; dcvStatus?: string };
const ws = (fields: Workstation): Workstation => fields;

describe('a ready workstation', () => {
  test('is running with a ready DCV agent', () => {
    const state = describeState(ws({ instanceStatus: 'running', status: 'Complete', dcvStatus: 'ready' }));
    expect(state).toMatchObject({ kind: 'ready', ready: true, busy: false, canStart: false });
  });

  test('is ready even while a late workflow step is still recorded', () => {
    expect(describeState(ws({ instanceStatus: 'running', status: 'dcv-ready', dcvStatus: 'ready' })).ready).toBe(true);
  });
});

describe('a starting workstation holds its status', () => {
  test('just told to start: the workflow step shows even though the instance is still stopped', () => {
    const state = describeState(ws({ instanceStatus: 'stopped', status: 'starting-instance', dcvStatus: 'stopped' }));
    expect(state).toMatchObject({ kind: 'busy', label: 'Starting instance', canStart: false });
  });

  test('instance up but the desktop is not registered yet is not "running"', () => {
    const state = describeState(ws({ instanceStatus: 'running', status: 'Complete', dcvStatus: 'starting' }));
    expect(state).toMatchObject({ kind: 'busy', label: 'Starting desktop', ready: false });
  });

  test.each(Object.keys(WORKFLOW_LABELS))('shows the step "%s" with the console wording', (step: string) => {
    const state = describeState(ws({ instanceStatus: 'running', status: step, dcvStatus: 'installing' }));
    expect(state.kind).toBe('busy');
    expect(state.label).toBe(WORKFLOW_LABELS[step]);
  });

  test('a pending instance reads Starting', () => {
    expect(describeState(ws({ instanceStatus: 'pending' })).label).toBe('Starting');
  });
});

describe('other states', () => {
  test('a stopped workstation can be started', () => {
    const state = describeState(ws({ instanceStatus: 'stopped', status: 'Stopped', dcvStatus: 'stopped' }));
    expect(state).toMatchObject({ kind: 'stopped', canStart: true, ready: false, busy: false });
  });

  test('a stopping workstation is busy and cannot be started', () => {
    expect(describeState(ws({ instanceStatus: 'stopping' }))).toMatchObject({ kind: 'busy', label: 'Stopping', canStart: false });
    expect(describeState(ws({ instanceStatus: 'running', status: 'Stopping' }))).toMatchObject({ kind: 'busy', label: 'Stopping' });
  });

  test('a failed DCV agent is a failure, whatever else the record says', () => {
    const state = describeState(ws({ instanceStatus: 'running', status: 'Complete', dcvStatus: 'failed' }));
    expect(state).toMatchObject({ kind: 'failed', failed: true, ready: false, canStart: false });
  });

  test('an unrecognised record is shown as busy and never as ready or startable', () => {
    const state = describeState(ws({ instanceStatus: 'something-new' }));
    expect(state.kind).toBe('busy');
    expect(state.ready).toBe(false);
    expect(state.canStart).toBe(false);
  });

  test('an empty or missing record does not throw', () => {
    expect(describeState({}).kind).toBe('busy');
    expect(describeState(undefined).kind).toBe('busy');
  });
});

describe('the DCV client link', () => {
  test('swaps https for dcv, as the console does', () => {
    expect(toDcvUrl('https://gw.example.com:8444/?authToken=T#s')).toBe('dcv://gw.example.com:8444/?authToken=T#s');
  });

  test('leaves anything that is not https, or not a string, alone', () => {
    expect(toDcvUrl('http://x/')).toBe('http://x/');
    expect(toDcvUrl(undefined)).toBeUndefined();
  });
});
