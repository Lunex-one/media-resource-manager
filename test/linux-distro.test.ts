// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the distribution detection behind `linuxDistro`, which
 * `lambda/instance-create-linux` writes onto a workstation record at creation and
 * `lambda/dcv-session-manager` reads to decide which OS user a DCV session belongs to.
 *
 * Hermetic: `lambda/instance-create-linux/linux-distro.js` is a pair of pure functions and imports
 * nothing. No AWS credentials, no SDK, no CDK synthesis.
 */

// `require` and not `import`, because the subject is a CommonJS lambda file and this project's
// tsconfig has no `allowJs`.
const { detectLinuxDistro, distroFromAmiOrImageName } = require('../lambda/instance-create-linux/linux-distro');

describe('detectLinuxDistro', () => {
  it('answers only in the four words dcv-session-manager understands, or null', () => {
    // The reader matches 'rocky', 'rhel' and 'centos' - all three meaning the `rocky` user - and
    // 'ubuntu', and treats any other value as it treats an absent one.
    const answers = [
      detectLinuxDistro('Rocky-9-x86_64'),
      detectLinuxDistro('RHEL-9.4'),
      detectLinuxDistro('CentOS Stream 9'),
      detectLinuxDistro('ubuntu/images/hvm-ssd/ubuntu-jammy-22.04'),
      detectLinuxDistro('windows-server-2022'),
    ];
    for (const answer of answers) {
      expect(answer === null || ['rocky', 'rhel', 'centos', 'ubuntu'].includes(answer)).toBe(true);
    }
  });

  it('reads rocky', () => {
    expect(detectLinuxDistro('Rocky-9-EC2-Base-9.4-20240509.0.x86_64')).toBe('rocky');
  });

  it('reads rhel from the abbreviation', () => {
    expect(detectLinuxDistro('RHEL-9.4.0_HVM-20240605-x86_64-82-Hourly2-GP3')).toBe('rhel');
  });

  it('reads rhel from the spelled-out name', () => {
    // A stock AMI's description says "Provided by Red Hat, Inc." and never the abbreviation.
    expect(detectLinuxDistro('some-ami-name', 'Provided by Red Hat, Inc.')).toBe('rhel');
  });

  it('reads centos', () => {
    expect(detectLinuxDistro('CentOS Stream 9 x86_64 20240701')).toBe('centos');
  });

  it('reads ubuntu', () => {
    expect(detectLinuxDistro('ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server')).toBe('ubuntu');
  });

  it('is not case sensitive', () => {
    expect(detectLinuxDistro('ROCKY LINUX 9')).toBe('rocky');
    expect(detectLinuxDistro('Ubuntu')).toBe('ubuntu');
  });

  it('answers null when no text names a distribution it knows', () => {
    expect(detectLinuxDistro('render-node-base-2026-08', 'Built by the image pipeline')).toBeNull();
  });

  it('answers null when handed nothing at all', () => {
    // The DescribeImages call can fail, or return an image with neither field set. Both arrive
    // here as nulls, and neither is a reason to guess.
    expect(detectLinuxDistro()).toBeNull();
    expect(detectLinuxDistro(null, null)).toBeNull();
    expect(detectLinuxDistro('', undefined)).toBeNull();
  });

  it('reads across the texts it is given in one call', () => {
    // The AMI's name and description are one body of evidence, and either may carry the word.
    expect(detectLinuxDistro(null, 'Rocky Linux 9 for the render pipeline')).toBe('rocky');
  });
});

describe('distroFromAmiOrImageName', () => {
  it('prefers what the AMI says over what the catalogue row is called', () => {
    // The case that makes this a rule rather than a detail: a catalogue row named for a
    // distribution the AMI it points at is not. `rocky` sorts before `ubuntu` in the word order,
    // so a single joined call would answer 'rocky' here and put the session on a user that does
    // not exist on that machine.
    expect(distroFromAmiOrImageName(
      'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server',
      'Canonical, Ubuntu, 24.04 LTS, amd64 noble image',
      'rocky-9-render',
    )).toBe('ubuntu');
  });

  it('falls back to the image name when the AMI cannot tell', () => {
    // A replicated regional copy does not always carry the source AMI's name into the region
    // being described, and a pipeline-built image often describes itself in its own words.
    expect(distroFromAmiOrImageName(
      'ami-copy-8fbc21',
      null,
      'Rocky 9 Editing Desktop',
    )).toBe('rocky');
  });

  it('falls back to the image name when DescribeImages told us nothing', () => {
    expect(distroFromAmiOrImageName(null, null, 'ubuntu-editorial-2026-08')).toBe('ubuntu');
  });

  it('answers null when neither the AMI nor the image name names a distribution', () => {
    // Nothing is then written to the record, and dcv-session-manager's own fallbacks run exactly
    // as they did before this field was ever written.
    expect(distroFromAmiOrImageName('ami-copy-8fbc21', 'Built 2026-08-30', 'editing-desktop')).toBeNull();
  });
});
