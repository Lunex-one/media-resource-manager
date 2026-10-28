// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The scripts the NFS Mount Manager sends to a workstation, as pure functions of its inputs.
//
// They run as root, and every value that did not originate here reaches them through
// `script-quote.js`. A workstation's `storageConfig[id].mountPath` and a storage record's `name`
// are written by an admin through the API with no validation, and until this module they were
// pasted between double quotes, into an unquoted heredoc and into a `sed` program, where `$(...)`
// ran as root. The NFS endpoint and junction path come from AWS, but take the same road.
//
// Kept apart from `index.js` so a test can read the scripts without AWS clients.
//
// Linux: the systemd `.mount` unit has to carry the endpoint and the mount path, because `What=`
// and `Where=` are the unit. Those two lines take a value only after `unitValue` below has refused
// what a unit file would read as syntax; the unit's name is still made on the host by
// `systemd-escape --path`, which is the only correct source of it, and the description names the
// service, never the storage. macOS: the launcher run at every boot is built here with each value
// a single-quoted literal and written with a quoted heredoc, and the launchd plist is built here
// with each value XML-escaped, so the host shell expands nothing into either.

const q = require('./script-quote');

/** The name every unit, launcher and plist for one storage is called by. */
function serviceNameFor(storageId) {
  return `nfs-fsxn-${q.plain(storageId, 'storage id').replace(/[^a-zA-Z0-9]/g, '-')}`;
}

/**
 * A value for a systemd unit file line. A unit file treats `%` as a specifier and a trailing
 * backslash as a line continuation, and a value carrying either would be read as something other
 * than itself; neither belongs in an NFS endpoint, junction or mount path, so both are refused
 * rather than escaped.
 */
function unitValue(value, what) {
  const text = q.plain(value, what);
  if (/[%\\]/.test(text)) {
    throw new q.UnsafeValueError(what, 'contains % or \\, which a systemd unit file reads as syntax');
  }
  return text;
}

/** The launcher macOS runs at every boot: mounts the export and makes the Finder symlink. */
function macOsLauncher(nfsEndpoint, junctionPath, mountPath, volumeLabel) {
  return `#!/bin/bash
MOUNT_PATH=${q.sh(mountPath, 'mount path')}
NFS_ENDPOINT=${q.sh(nfsEndpoint, 'NFS endpoint')}
JUNCTION_PATH=${q.sh(junctionPath, 'junction path')}
VOLUME_LABEL=${q.sh(q.fileName(volumeLabel, 'volume label'), 'volume label')}

# Check if already mounted
if mount | grep -qF -- "$MOUNT_PATH"; then
    echo "Already mounted"
    exit 0
fi

# Mount with macOS-specific options
# resvport: Use reserved port (required for some NFS servers)
# nfc: Normalize filenames to NFC (better compatibility)
# rsize/wsize: Large block sizes for performance
mount -t nfs -o resvport,nfc,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2 \\
    "$NFS_ENDPOINT:$JUNCTION_PATH" "$MOUNT_PATH"

if [ $? -eq 0 ]; then
    echo "Successfully mounted FSxN at $MOUNT_PATH"

    # Set custom Finder name for the volume
    # This creates a .localized folder with display name
    if [ -n "$VOLUME_LABEL" ]; then
        echo "Setting Finder display name to: $VOLUME_LABEL"
        # Use xattr to set Finder display name (works on NFS mounts)
        # The com.apple.FinderInfo attribute doesn't work on NFS, so we use a symlink approach
        # Create a friendly symlink in /Volumes if mount path is elsewhere. The label is a file
        # name, never a path, so the link always lands directly in /Volumes.
        FRIENDLY_LINK="/Volumes/$VOLUME_LABEL"
        if [ "$MOUNT_PATH" != "$FRIENDLY_LINK" ] && [ ! -e "$FRIENDLY_LINK" ]; then
            sudo ln -sf -- "$MOUNT_PATH" "$FRIENDLY_LINK" 2>/dev/null || true
            echo "Created friendly symlink: $FRIENDLY_LINK -> $MOUNT_PATH"
        fi
    fi
else
    echo "Failed to mount FSxN"
    exit 1
fi`;
}

/** The launchd plist that runs the launcher at load and keeps the mount path present. */
function macOsPlist(plistName, mountScript, mountPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${q.xml(plistName, 'plist name')}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${q.xml(mountScript, 'mount script path')}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>PathState</key>
        <dict>
            <key>${q.xml(mountPath, 'mount path')}</key>
            <false/>
        </dict>
    </dict>
    <key>StandardOutPath</key>
    <string>/var/log/fsxn-mount.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/fsxn-mount.log</string>
</dict>
</plist>`;
}

/** The systemd `.mount` unit. `What=` and `Where=` are the only lines holding a value. */
function linuxMountUnit(nfsEndpoint, junctionPath, mountPath, serviceName) {
  const what = `${unitValue(nfsEndpoint, 'NFS endpoint')}:${unitValue(junctionPath, 'junction path')}`;
  return `[Unit]
Description=FSxN NFS Mount - ${serviceName}
After=network-online.target
Wants=network-online.target

[Mount]
What=${what}
Where=${unitValue(mountPath, 'mount path')}
Type=nfs
Options=nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport

[Install]
WantedBy=multi-user.target`;
}

/**
 * Generate Linux NFS mount script using systemd
 */
function generateLinuxNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName) {
  return `#!/bin/bash
set -e

NFS_ENDPOINT=${q.sh(nfsEndpoint, 'NFS endpoint')}
JUNCTION_PATH=${q.sh(junctionPath, 'junction path')}
MOUNT_PATH=${q.sh(mountPath, 'mount path')}
SERVICE_NAME=${q.sh(serviceName, 'service name')}

echo "Setting up NFS mount for FSxN: $NFS_ENDPOINT:$JUNCTION_PATH -> $MOUNT_PATH"

# Detect OS type
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
else
    OS_ID="unknown"
fi

echo "Detected OS: $OS_ID"

# Install NFS client if not present
if ! command -v mount.nfs &> /dev/null; then
    echo "Installing NFS client..."
    case "$OS_ID" in
        amzn|rhel|centos|rocky|fedora)
            sudo yum install -y nfs-utils
            ;;
        ubuntu|debian)
            sudo apt-get update
            sudo apt-get install -y nfs-common
            ;;
        *)
            echo "Warning: Unknown OS, assuming NFS client is installed"
            ;;
    esac
fi

# Create mount directory
echo "Creating mount directory: $MOUNT_PATH"
sudo mkdir -p -- "$MOUNT_PATH"

# Use systemd-escape to properly generate unit name from path
# This handles special characters like dashes correctly
UNIT_NAME=$(systemd-escape --path -- "$MOUNT_PATH")

# The unit is written with a quoted heredoc delimiter, so nothing in it is expanded here.
echo "Creating systemd mount unit: $UNIT_NAME.mount"
sudo tee "/etc/systemd/system/$UNIT_NAME.mount" > /dev/null << 'MRM_UNIT_EOF'
${linuxMountUnit(nfsEndpoint, junctionPath, mountPath, serviceName)}
MRM_UNIT_EOF

# Reload systemd and enable/start the mount directly (skip automount for simplicity)
echo "Enabling and starting NFS mount..."
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME.mount"
sudo systemctl start "$UNIT_NAME.mount"
# Verify mount
sleep 2
if mountpoint -q "$MOUNT_PATH"; then
    echo "SUCCESS: FSxN NFS mounted at $MOUNT_PATH"
    df -h -- "$MOUNT_PATH" 2>/dev/null || true
    ls -la -- "$MOUNT_PATH" || true
else
    echo "ERROR: Mount failed"
    systemctl status "$UNIT_NAME.mount" || true
    exit 1
fi
`;
}

/**
 * Generate macOS NFS mount script using launchd
 */
function generateMacOsNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName) {
  const plistName = `com.fsxn.mount.${serviceName}`;
  const mountScript = `/usr/local/bin/mount-fsxn-${serviceName}.sh`;
  // Use storage name for Finder display, fallback to serviceName
  const volumeLabel = storage.name || `FSxN-${serviceName}`;

  return `#!/bin/bash
set -e

NFS_ENDPOINT=${q.sh(nfsEndpoint, 'NFS endpoint')}
JUNCTION_PATH=${q.sh(junctionPath, 'junction path')}
MOUNT_PATH=${q.sh(mountPath, 'mount path')}
PLIST_NAME=${q.sh(plistName, 'plist name')}
MOUNT_SCRIPT=${q.sh(mountScript, 'mount script path')}

echo "Setting up NFS mount for FSxN on macOS: $NFS_ENDPOINT:$JUNCTION_PATH -> $MOUNT_PATH"

# Create mount directory
echo "Creating mount directory: $MOUNT_PATH"
sudo mkdir -p -- "$MOUNT_PATH"

# Create mount script. Every value in it is a single-quoted literal, and the quoted heredoc
# delimiter means nothing in it is expanded here.
echo "Creating mount script: $MOUNT_SCRIPT"
sudo tee "$MOUNT_SCRIPT" > /dev/null << 'MRM_SCRIPT_EOF'
${macOsLauncher(nfsEndpoint, junctionPath, mountPath, volumeLabel)}
MRM_SCRIPT_EOF

sudo chmod +x "$MOUNT_SCRIPT"

# Create launchd plist for auto-mount at login. Its values are XML-escaped where it is built.
PLIST_PATH="/Library/LaunchDaemons/$PLIST_NAME.plist"
echo "Creating launchd plist: $PLIST_PATH"
sudo tee "$PLIST_PATH" > /dev/null << 'MRM_PLIST_EOF'
${macOsPlist(plistName, mountScript, mountPath)}
MRM_PLIST_EOF

# Load the launchd job
echo "Loading launchd job..."
sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
sudo launchctl load "$PLIST_PATH"

# Run the mount script immediately
echo "Mounting now..."
sudo "$MOUNT_SCRIPT"

# Verify mount
if mount | grep -qF -- "$MOUNT_PATH"; then
    echo "SUCCESS: FSxN NFS mounted at $MOUNT_PATH"
    df -h "$MOUNT_PATH"
else
    echo "WARNING: Mount may not be active yet - will mount on next boot or access"
fi
`;
}

function generateLinuxNfsUnmountScript(mountPath, serviceName) {
  return `#!/bin/bash
set -e

MOUNT_PATH=${q.sh(mountPath, 'mount path')}
UNIT_NAME=$(systemd-escape --path -- "$MOUNT_PATH")

echo "Unmounting NFS storage: $MOUNT_PATH"

# Stop and disable systemd units
if systemctl is-active --quiet "$UNIT_NAME.automount" 2>/dev/null; then
    echo "Stopping automount..."
    sudo systemctl stop "$UNIT_NAME.automount"
fi

if systemctl is-active --quiet "$UNIT_NAME.mount" 2>/dev/null; then
    echo "Stopping mount..."
    sudo systemctl stop "$UNIT_NAME.mount"
fi

sudo systemctl disable "$UNIT_NAME.automount" 2>/dev/null || true
sudo systemctl disable "$UNIT_NAME.mount" 2>/dev/null || true

# Remove unit files
sudo rm -f "/etc/systemd/system/$UNIT_NAME.mount"
sudo rm -f "/etc/systemd/system/$UNIT_NAME.automount"

# Also clean up old-style unit files (without proper escaping). The path is sed's input here,
# never its program, and the result can hold no slash, so it names a file in this directory.
OLD_UNIT_NAME=$(printf '%s' "$MOUNT_PATH" | sed 's|^/||' | sed 's|/|-|g')
sudo rm -f "/etc/systemd/system/$OLD_UNIT_NAME.mount"
sudo rm -f "/etc/systemd/system/$OLD_UNIT_NAME.automount"

sudo systemctl daemon-reload

# Unmount if still mounted
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "Force unmounting..."
    sudo umount -f -- "$MOUNT_PATH" || sudo umount -l -- "$MOUNT_PATH"
fi

# Remove mount directory if empty
if [ -d "$MOUNT_PATH" ] && [ -z "$(ls -A -- "$MOUNT_PATH" 2>/dev/null)" ]; then
    echo "Removing empty mount directory..."
    sudo rmdir -- "$MOUNT_PATH" 2>/dev/null || true
fi

echo "NFS storage unmounted successfully"
`;
}

function generateMacOsNfsUnmountScript(mountPath, serviceName) {
  const plistName = `com.fsxn.mount.${serviceName}`;

  return `#!/bin/bash
set -e

MOUNT_PATH=${q.sh(mountPath, 'mount path')}
PLIST_NAME=${q.sh(plistName, 'plist name')}
PLIST_PATH="/Library/LaunchDaemons/$PLIST_NAME.plist"
MOUNT_SCRIPT=${q.sh(`/usr/local/bin/mount-fsxn-${serviceName}.sh`, 'mount script path')}

echo "Unmounting NFS storage: $MOUNT_PATH"

# Unload launchd job
if [ -f "$PLIST_PATH" ]; then
    echo "Unloading launchd job..."
    sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
    sudo rm -f "$PLIST_PATH"
fi

# Remove mount script
if [ -f "$MOUNT_SCRIPT" ]; then
    sudo rm -f "$MOUNT_SCRIPT"
fi

# Remove any symlinks in /Volumes pointing to our mount path
for link in /Volumes/*; do
    if [ -L "$link" ]; then
        target=$(readlink "$link" 2>/dev/null || true)
        if [ "$target" = "$MOUNT_PATH" ]; then
            echo "Removing symlink: $link"
            sudo rm -f "$link"
        fi
    fi
done

# Unmount if mounted
if mount | grep -qF -- "$MOUNT_PATH"; then
    echo "Unmounting..."
    sudo umount -- "$MOUNT_PATH" || sudo diskutil unmount force "$MOUNT_PATH"
fi

# Remove mount directory if empty
if [ -d "$MOUNT_PATH" ] && [ -z "$(ls -A -- "$MOUNT_PATH" 2>/dev/null)" ]; then
    echo "Removing empty mount directory..."
    sudo rmdir -- "$MOUNT_PATH" 2>/dev/null || true
fi

echo "NFS storage unmounted successfully"
`;
}

/** The status check for a Linux workstation. */
function generateLinuxStatusScript(mountPath) {
  return `#!/bin/bash
MOUNT_PATH=${q.sh(mountPath, 'mount path')}

if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "MOUNTED"
else
    echo "NOT_MOUNTED"
fi
`;
}

/** The status check for a macOS workstation. */
function generateMacOsStatusScript(mountPath) {
  return `#!/bin/bash
MOUNT_PATH=${q.sh(mountPath, 'mount path')}

if mount | grep -qF -- "$MOUNT_PATH"; then
    echo "MOUNTED"
else
    echo "NOT_MOUNTED"
fi
`;
}

module.exports = {
  serviceNameFor,
  unitValue,
  linuxMountUnit,
  macOsLauncher,
  macOsPlist,
  generateLinuxNfsMountScript,
  generateMacOsNfsMountScript,
  generateLinuxNfsUnmountScript,
  generateMacOsNfsUnmountScript,
  generateLinuxStatusScript,
  generateMacOsStatusScript,
};
