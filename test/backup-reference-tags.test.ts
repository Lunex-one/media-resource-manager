// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a filesystem's automatic backups can be attributed to the project
 * that pays for them.
 *
 * The fault this guards against is not a crash and not a wrong number - it is
 * a charge that belongs to nobody. CloudFormation puts ConstellationId and
 * ProjectId on the file system as stack tags, but FSx takes the daily backup
 * itself, and unless CopyTagsToBackups is set it copies none of them onto it.
 * The backup is then billed under a backup id that exists nowhere outside FSx,
 * so no per-project cost query can reach it, and nothing anywhere reports that
 * a line is missing.
 *
 * Tags are also not retroactive on a bill, so a backup that is created
 * untagged is unattributable for as long as it exists. That is what makes this
 * worth a test rather than a comment: removing the flag would cost money
 * quietly, and the only place the loss shows up is a total that does not add
 * up months later.
 */

// The handler builds SDK clients at module load, and this checkout does not
// install every package the Lambda runtime provides. Only Secrets Manager is
// missing, and nothing in these tests calls it - the two template builders are
// pure functions of their arguments. Hence a virtual mock rather than a
// dependency.
jest.mock(
  '@aws-sdk/client-secrets-manager',
  () => ({
    SecretsManagerClient: class {},
    GetSecretValueCommand: class {},
    CreateSecretCommand: class {},
    PutSecretValueCommand: class {}
  }),
  { virtual: true }
);

const {
  generateFsxWindowsTemplate,
  generateFsxOntapTemplate
} = require('../lambda/generate-fsx-template/index.js');

/** An FSx for Windows request, as create-storage passes one on. */
const windowsConfiguration = {
  ssdStorageCapacity: 1024,
  throughputCapacity: 32,
  automaticBackupRetentionPeriod: 7
};

const adCredentials = { username: 'svc-fsx', password: 'not-a-real-password' };

/** An FSx for NetApp ONTAP request. 1024 GiB clears the FlexGroup minimum. */
const ontapConfiguration = {
  haPairs: 1,
  throughputCapacityPerHaPair: 3072,
  deploymentType: 'SINGLE_AZ_2',
  volumeSize: 1024,
  backupRetention: 30
};

describe('FSx for Windows', () => {
  const template = generateFsxWindowsTemplate(
    'stor-1',
    'Grade Store',
    windowsConfiguration,
    'MediaResourceManager',
    adCredentials
  );
  const fileSystem = template.Resources.FsxFileSystem.Properties;

  test('the backup takes the file system tags', () => {
    expect(fileSystem.WindowsConfiguration.CopyTagsToBackups).toBe(true);
  });

  test('automatic backups are on, which is what makes the flag matter', () => {
    // Retention is the caller's to choose - supply sends 7 days - but a flag
    // copying tags onto a backup nobody takes would be decoration. If this
    // ever becomes 0 the two settings should be reconsidered together.
    expect(fileSystem.WindowsConfiguration.AutomaticBackupRetentionDays).toEqual({
      Ref: 'AutomaticBackupRetentionPeriod'
    });
  });

  test('the references reach the file system as stack tags, not from here', () => {
    // The template names only the resource's own Name. ConstellationId and
    // ProjectId arrive on the CreateStack call in storage-cfn-worker, and
    // CloudFormation applies them to every resource in the stack that supports
    // tagging - so the file system already carries them by the time FSx takes
    // a backup. That is why the flag above is the whole fix and nothing here
    // needs to know the tag keys.
    expect(fileSystem.Tags).toEqual([{ Key: 'Name', Value: { Ref: 'StorageName' } }]);
  });
});

describe('FSx for NetApp ONTAP', () => {
  const template = generateFsxOntapTemplate(
    'stor-2',
    'Online Store',
    ontapConfiguration,
    'MediaResourceManager',
    'not-a-real-password'
  );

  test('the flag is on the volume, because that is what is backed up', () => {
    // An ONTAP backup is a backup of a volume rather than of the file system,
    // so CopyTagsToBackups belongs on the volume. The file system's own
    // configuration carries the retention and has no such field.
    const volume = template.Resources.FsxOntapVolume.Properties;
    expect(volume.OntapConfiguration.CopyTagsToBackups).toBe(true);
  });

  test('the volume is tagged by the stack, the same as the file system', () => {
    const volume = template.Resources.FsxOntapVolume.Properties;
    expect(volume.Tags).toEqual([
      { Key: 'Name', Value: { 'Fn::Sub': '${StorageName}-vol1' } }
    ]);
  });
});
