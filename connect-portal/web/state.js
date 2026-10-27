// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// What state a workstation is in, and what the page can offer for it. The same rules the MRM
// console uses: a machine is ready only when its instance is running AND its DCV agent says ready;
// while the workflow status holds a step name the page shows that step, so the status is held
// through the whole start instead of flipping to "Running" when the instance comes up.
//
// Loaded as a plain script in the browser (it sets globalThis.PortalState) and with require() in
// the unit tests.

(function (root) {
  'use strict';

  var WORKFLOW_LABELS = {
    'launching': 'Launching',
    'starting-instance': 'Starting instance',
    'instance-running': 'Instance running',
    'installing-dcv': 'Installing DCV',
    'configuring-dcv': 'Configuring DCV',
    'joining-domain': 'Joining domain',
    'configuring-system': 'Configuring system',
    'configuring-autologin': 'Configuring sign-in',
    'starting-dcv-agents': 'Starting DCV agents',
    'testing-dcv': 'Testing DCV',
    'dcv-ready': 'DCV ready',
    'dcv-session-created': 'Preparing session',
    'finalizing': 'Finalizing',
    'cleaning-up': 'Cleaning up',
  };

  function state(kind, label) {
    return {
      kind: kind,
      label: label,
      ready: kind === 'ready',
      busy: kind === 'busy',
      failed: kind === 'failed',
      canStart: kind === 'stopped',
    };
  }

  /** The state of one workstation record as the portal API returns it. */
  function describe(workstation) {
    var instance = String((workstation && workstation.instanceStatus) || '').toLowerCase();
    var status = String((workstation && workstation.status) || '');
    var dcv = String((workstation && workstation.dcvStatus) || '').toLowerCase();

    if (dcv === 'failed') return state('failed', 'Failed');
    if (instance === 'running' && dcv === 'ready') return state('ready', 'Ready');
    if (WORKFLOW_LABELS[status]) return state('busy', WORKFLOW_LABELS[status]);
    if (instance === 'pending') return state('busy', 'Starting');
    if (instance === 'stopping' || instance === 'shutting-down' || status.toLowerCase() === 'stopping') {
      return state('busy', 'Stopping');
    }
    if (instance === 'running') return state('busy', 'Starting desktop');
    if (instance === 'stopped') return state('stopped', 'Stopped');
    return state('busy', status || instance || 'Working');
  }

  /** The link the native DCV client registers: the console swaps https:// for dcv://. */
  function toDcvUrl(url) {
    return typeof url === 'string' ? url.replace(/^https:/, 'dcv:') : url;
  }

  var api = { describe: describe, toDcvUrl: toDcvUrl, WORKFLOW_LABELS: WORKFLOW_LABELS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PortalState = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
