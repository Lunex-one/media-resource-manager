// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DCV session manager and connection gateway boot scripts install current security updates
 * before they install anything else. The AMI is only as current as the day it was built (the
 * 2026-11 Datadog findings were instances launched in August and never updated), so a replaced
 * instance must patch itself. A failed update must never stop the DCV install, and the regional
 * hub generator must see the very same scripts as the primary stack.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const scripts = ['session-manager-install.sh', 'connection-gateway-install.sh'];

describe.each(scripts)('boot script %s', (name: string) => {
  const primary = path.join(root, 'user-data', name);
  const hubCopy = path.join(root, 'lambda', 'generate-regional-hub-template', 'user-data', name);
  const text = fs.readFileSync(primary, 'utf8');

  test('installs security updates before it installs the DCV package', () => {
    const update = text.indexOf('dnf upgrade --security --releasever=latest');
    const install = text.indexOf('rpm --import');
    expect(update).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(update).toBeLessThan(install);
  });

  test('a failed update does not stop the install', () => {
    expect(text).toMatch(/if dnf upgrade --security --releasever=latest -y [^\n]*; then/);
  });

  test('is limited to Amazon Linux 2023, where --releasever=latest is meaningful', () => {
    expect(text).toMatch(/\[ "\$system" = "amzn" \] && \[ "\$version" = "2023" \]/);
  });

  test('parses as bash', () => {
    expect(() => execFileSync('bash', ['-n', primary])).not.toThrow();
  });

  test('the regional hub generator sees the same script', () => {
    expect(fs.readFileSync(hubCopy, 'utf8')).toBe(text);
  });
});
