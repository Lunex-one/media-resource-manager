// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The scripts the S3 Mount Manager sends to a workstation, as pure functions of a storage record.
//
// They run as root (Linux) or SYSTEM (Windows), and every value from the storage record reaches
// them through `script-quote.js`: a record's name, bucket, prefix, mount path and cache path are
// written by whoever creates the storage, and until this module they were pasted between double
// quotes, where `$(...)` runs. Kept apart from `index.js` so a test can read the scripts without
// AWS clients.
//
// Linux: the values live in one root-owned launcher script, `/usr/local/lib/mrm-s3-mount/<service>.sh`,
// as single-quoted assignments, and the systemd unit only calls that launcher with `start` or
// `stop`. A unit file has its own quoting, its own `%` specifiers and its own line structure, so
// no record value is ever written into one.

const q = require('./script-quote');

const LAUNCHER_DIR = '/usr/local/lib/mrm-s3-mount';

/** The name every service, task and launcher file for one storage is called by. */
function serviceNameFor(storageId) {
  return `mountpoint-s3-${q.plain(storageId, 'storage id').replace(/[^a-zA-Z0-9]/g, '-')}`;
}

/** The `mount-s3` options for a storage record, each one a separate bash word. */
function linuxMountOptions(storage) {
  const options = [];
  if (storage.prefix) {
    options.push('--prefix', q.sh(storage.prefix, 'prefix'));
  }
  if (storage.accessMode === 'read-only') {
    options.push('--read-only');
  }
  if (storage.accessMode === 'read-write' && storage.allowDelete) {
    options.push('--allow-delete');
  }
  if (storage.allowOther) {
    options.push('--allow-other');
  }
  if (storage.uid) {
    options.push('--uid', q.integer(storage.uid, 'uid'));
  }
  if (storage.gid) {
    options.push('--gid', q.integer(storage.gid, 'gid'));
  }
  if (storage.cachePath) {
    options.push('--cache', q.sh(storage.cachePath, 'cache path'));
  }
  return options.join(' ');
}

/**
 * The launcher systemd runs: `start` mounts, `stop` unmounts. Written with a quoted heredoc, so
 * the outer script expands nothing inside it; the values in it are single-quoted literals.
 */
function linuxLauncher(storage) {
  return `#!/bin/bash
# Written by the MRM S3 Mount Manager. Started and stopped by systemd.
BUCKET_NAME=${q.sh(storage.bucketName, 'bucket name')}
MOUNT_PATH=${q.sh(storage.mountPath, 'mount path')}
MOUNT_OPTIONS=(${linuxMountOptions(storage)})
case "$1" in
    start) exec /usr/bin/mount-s3 "$BUCKET_NAME" "$MOUNT_PATH" "\${MOUNT_OPTIONS[@]}" ;;
    stop) exec /usr/bin/umount "$MOUNT_PATH" ;;
    *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac`;
}

/**
 * The bash script to install mountpoint, write the launcher and the systemd service, mount, and
 * put a shortcut on every user's desktop.
 */
function generateMountScript(storage, serviceName) {
  const desktopFile = `${q.fileName(storage.name, 'storage name')}.desktop`;
  return `#!/bin/bash
set -e

BUCKET_NAME=${q.sh(storage.bucketName, 'bucket name')}
MOUNT_PATH=${q.sh(storage.mountPath, 'mount path')}
SERVICE_NAME=${q.sh(serviceName, 'service name')}
LAUNCHER=${q.sh(`${LAUNCHER_DIR}/${serviceName}.sh`, 'launcher path')}
CACHE_PATH=${storage.cachePath ? q.sh(storage.cachePath, 'cache path') : "''"}
DESKTOP_NAME=${q.sh(q.desktopString(storage.name, 'storage name'), 'storage name')}
DESKTOP_COMMENT=${q.sh(q.desktopString(`S3 Mount: ${q.plain(storage.bucketName, 'bucket name')}`), 'comment')}
DESKTOP_EXEC=${q.sh(`xdg-open ${q.desktopExecArg(storage.mountPath, 'mount path')}`, 'desktop exec')}
DESKTOP_FILE_NAME=${q.sh(desktopFile, 'desktop file name')}

echo "Setting up Mountpoint for S3: $BUCKET_NAME -> $MOUNT_PATH"

# Detect OS type
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
else
    OS_ID="unknown"
fi

echo "Detected OS: $OS_ID"

# Install mountpoint-s3 if not already installed
if ! command -v mount-s3 &> /dev/null; then
    echo "Installing Mountpoint for S3..."

    case "$OS_ID" in
        amzn|rhel|centos|rocky|fedora)
            # RPM-based systems
            cd /tmp
            curl -sL -o mount-s3.rpm "https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm"
            sudo yum install -y ./mount-s3.rpm
            rm -f mount-s3.rpm
            ;;
        ubuntu|debian)
            # DEB-based systems
            cd /tmp
            curl -sL -o mount-s3.deb "https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.deb"
            sudo apt-get install -y ./mount-s3.deb
            rm -f mount-s3.deb
            ;;
        *)
            echo "Unsupported OS: $OS_ID"
            exit 1
            ;;
    esac

    echo "Mountpoint for S3 installed successfully"
else
    echo "Mountpoint for S3 already installed"
fi

# Create mount directory
echo "Creating mount directory: $MOUNT_PATH"
sudo mkdir -p -- "$MOUNT_PATH"

# Enable user_allow_other in fuse.conf for --allow-other to work
if ! grep -q "^user_allow_other" /etc/fuse.conf 2>/dev/null; then
    echo "Enabling user_allow_other in /etc/fuse.conf..."
    echo "user_allow_other" | sudo tee -a /etc/fuse.conf > /dev/null
fi

# Create cache directory if specified
if [ -n "$CACHE_PATH" ]; then
    echo "Creating cache directory: $CACHE_PATH"
    sudo mkdir -p -- "$CACHE_PATH"
fi

# Write the launcher systemd calls. Every value in it is a single-quoted literal, and the quoted
# heredoc delimiter means nothing in it is expanded here.
sudo mkdir -p ${LAUNCHER_DIR}
sudo tee "$LAUNCHER" > /dev/null << 'MRM_LAUNCHER_EOF'
${linuxLauncher(storage)}
MRM_LAUNCHER_EOF
sudo chmod 0755 "$LAUNCHER"

# Create systemd service file. No record value is written into it.
echo "Creating systemd service: $SERVICE_NAME"
sudo tee "/etc/systemd/system/$SERVICE_NAME.service" > /dev/null << 'MRM_UNIT_EOF'
[Unit]
Description=Mountpoint for S3 - ${serviceName}
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/bin/bash ${LAUNCHER_DIR}/${serviceName}.sh start
ExecStop=/bin/bash ${LAUNCHER_DIR}/${serviceName}.sh stop
Restart=on-failure
RestartSec=10
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
MRM_UNIT_EOF

# Reload systemd and enable service
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

# Verify mount
sleep 2
if mountpoint -q "$MOUNT_PATH"; then
    echo "SUCCESS: S3 bucket mounted at $MOUNT_PATH"
    ls -la -- "$MOUNT_PATH" | head -10

    # Create desktop shortcut for all users with home directories
    for USER_HOME in /home/*; do
        # Skip synthetic entries that a wildcard may produce (e.g. /home/lost+found)
        [ -d "$USER_HOME" ] || continue
        USERNAME=$(basename "$USER_HOME")
        # Ensure ~/Desktop exists. Ubuntu creates it via xdg-user-dirs on first
        # login, but Rocky Linux 8's minimal desktop install does not, so
        # without this mkdir the shortcut would be silently skipped there.
        if [ ! -d "$USER_HOME/Desktop" ]; then
            mkdir -p "$USER_HOME/Desktop"
            chown "$USERNAME:$USERNAME" "$USER_HOME/Desktop"
            chmod 755 "$USER_HOME/Desktop"
        fi
        if [ -d "$USER_HOME/Desktop" ]; then
            DESKTOP_FILE="$USER_HOME/Desktop/$DESKTOP_FILE_NAME"
            echo "Creating desktop shortcut for $USERNAME..."
            printf '%s\\n' \\
                '[Desktop Entry]' \\
                'Type=Application' \\
                "Name=$DESKTOP_NAME" \\
                "Comment=$DESKTOP_COMMENT" \\
                'Icon=folder-remote' \\
                "Exec=$DESKTOP_EXEC" \\
                'Terminal=false' > "$DESKTOP_FILE"
            chown "$USERNAME:$USERNAME" "$DESKTOP_FILE"
            chmod 755 "$DESKTOP_FILE"
            # Mark the shortcut as trusted in GVFS metadata so GNOME does not
            # gate the first double-click behind an "Untrusted Desktop File —
            # right-click to Allow Launching" prompt. gio set writes to the
            # user's GVFS metadata store, which requires a running DBus session
            # bus; sudo -u alone does not export DBUS_SESSION_BUS_ADDRESS, so
            # we point gio at the target user's session bus explicitly. When
            # the bus is not yet available (e.g. mount fires before first
            # graphical login), the write is skipped and the user hits the
            # one-time GNOME prompt instead — no worse than pre-fix behavior.
            USER_UID=$(id -u "$USERNAME" 2>/dev/null || echo "")
            if [ -n "$USER_UID" ] && [ -S "/run/user/$USER_UID/bus" ]; then
                sudo -u "$USERNAME" \\
                    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_UID/bus" \\
                    gio set "$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
            fi
        fi
    done
else
    echo "ERROR: Mount verification failed"
    sudo systemctl status "$SERVICE_NAME" --no-pager || true
    exit 1
fi
`;
}

/** The bash script that stops the service and removes what the mount script wrote. */
function generateUnmountScript(storage, serviceName) {
  return `#!/bin/bash
set -e

SERVICE_NAME=${q.sh(serviceName, 'service name')}
LAUNCHER=${q.sh(`${LAUNCHER_DIR}/${serviceName}.sh`, 'launcher path')}
MOUNT_PATH=${q.sh(storage.mountPath, 'mount path')}
DESKTOP_FILE_NAME=${q.sh(`${q.fileName(storage.name, 'storage name')}.desktop`, 'desktop file name')}

echo "Unmounting S3 storage: $MOUNT_PATH"

# Stop and disable the systemd service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Stopping service $SERVICE_NAME..."
    sudo systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Disabling service $SERVICE_NAME..."
    sudo systemctl disable "$SERVICE_NAME"
fi

# Remove the service file and its launcher
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$SERVICE_FILE" ]; then
    echo "Removing service file..."
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
fi
sudo rm -f "$LAUNCHER"

# Unmount if still mounted (use lazy unmount to handle busy mounts)
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "Unmounting $MOUNT_PATH..."
    sudo umount -l -- "$MOUNT_PATH" || true
    sleep 1
fi

# Remove mount directory if empty or stale
if [ -d "$MOUNT_PATH" ]; then
    # Check if it's a stale mount point (transport endpoint not connected)
    if ! mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
        echo "Removing mount directory..."
        sudo rmdir -- "$MOUNT_PATH" 2>/dev/null || true
    fi
fi

# Remove desktop shortcuts for all users
for USER_HOME in /home/*; do
    DESKTOP_FILE="$USER_HOME/Desktop/$DESKTOP_FILE_NAME"
    if [ -f "$DESKTOP_FILE" ]; then
        echo "Removing desktop shortcut: $DESKTOP_FILE"
        rm -f -- "$DESKTOP_FILE"
    fi
done

echo "S3 storage unmounted successfully"
`;
}

/** The bash script that reports whether the storage is mounted and its service running. */
function generateStatusScript(storage, serviceName) {
  return `#!/bin/bash
MOUNT_PATH=${q.sh(storage.mountPath, 'mount path')}
SERVICE_NAME=${q.sh(serviceName, 'service name')}

# Check if mounted
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "MOUNTED"
    # Check service status
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "SERVICE_ACTIVE"
    else
        echo "SERVICE_INACTIVE"
    fi
else
    echo "NOT_MOUNTED"
fi
`;
}

const RCLONE_PATH = 'C:\\ProgramData\\rclone\\rclone.exe';

/**
 * The rclone command line the Windows mount launcher runs, built here so each argument is quoted
 * by the Windows rules once, rather than by a PowerShell expression that only quoted arguments
 * containing whitespace and let a quote inside one split it.
 */
function windowsRcloneCommandLine(storage, region) {
  let remote = `:s3,provider=AWS,env_auth=true,region=${q.plain(region, 'region')}:${q.plain(storage.bucketName, 'bucket name')}`;
  if (storage.prefix) {
    remote = `${remote}/${q.plain(storage.prefix, 'prefix')}`;
  }
  const args = ['mount', remote, q.plain(storage.mountPath, 'mount path'),
    '--vfs-cache-mode', 'writes', '--dir-cache-time', '30s',
    '--volname', q.plain(storage.name, 'storage name')];
  if (storage.accessMode === 'read-only') {
    args.push('--read-only');
  }
  if (storage.cachePath) {
    args.push('--cache-dir', q.plain(storage.cachePath, 'cache path'));
  }
  return [RCLONE_PATH, ...args].map((arg) => q.winArg(arg)).join(' ');
}

/**
 * The PowerShell script to install rclone+WinFsp and put Mount and Unmount shortcuts on the
 * public desktop.
 *
 * Windows session isolation means a drive mounted by a SYSTEM-context service is invisible to the
 * interactive user's Explorer/DCV session, so the mount runs from a shortcut in the user's own
 * session instead.
 */
function generateWindowsMountScript(storage, taskName) {
  const region = storage.region || process.env.AWS_REGION;
  const commandLine = windowsRcloneCommandLine(storage, region);
  return `$ErrorActionPreference = "Stop"

$BucketName = ${q.ps(storage.bucketName, 'bucket name')}
$MountPath = ${q.ps(storage.mountPath, 'mount path')}
$CachePath = ${q.ps(storage.cachePath || '', 'cache path')}
$TaskName = ${q.ps(taskName, 'task name')}
$SafeStorageName = ${q.ps(q.fileName(storage.name, 'storage name'), 'storage name')}
$RcloneCmdLine = ${q.ps(commandLine, 'rclone command line')}
$UnmountMatchArg = ${q.ps(q.winArg(storage.mountPath, 'mount path'), 'mount path')}

function Write-Log {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

Write-Log "Setting up rclone S3 mount: $BucketName -> $MountPath"

$RcloneDir = "C:\\ProgramData\\rclone"
$RclonePath = "$RcloneDir\\rclone.exe"

# --- Install rclone if not present ---
if (-not (Test-Path -LiteralPath $RclonePath)) {
    Write-Log "Installing rclone..."
    $rcloneZip = "$env:TEMP\\rclone.zip"
    $rcloneExtract = "$env:TEMP\\rclone-extract"
    Invoke-WebRequest -Uri "https://downloads.rclone.org/rclone-current-windows-amd64.zip" -OutFile $rcloneZip -UseBasicParsing
    if (Test-Path $rcloneExtract) { Remove-Item $rcloneExtract -Recurse -Force }
    Expand-Archive -Path $rcloneZip -DestinationPath $rcloneExtract -Force
    New-Item -Path $RcloneDir -ItemType Directory -Force | Out-Null
    $extractedExe = Get-ChildItem -Path $rcloneExtract -Filter "rclone.exe" -Recurse | Select-Object -First 1
    if (-not $extractedExe) {
        throw "rclone.exe not found in downloaded archive"
    }
    Copy-Item -Path $extractedExe.FullName -Destination $RclonePath -Force
    Remove-Item $rcloneZip -Force -ErrorAction SilentlyContinue
    Remove-Item $rcloneExtract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Log "rclone installed at $RclonePath"
} else {
    Write-Log "rclone already installed"
}

# --- Install WinFsp if not present (required for rclone mount on Windows) ---
$winfspInstalled = Test-Path "$env:ProgramFiles\\WinFsp\\bin\\winfsp-x64.dll"
if (-not $winfspInstalled) {
    Write-Log "Installing WinFsp..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/winfsp/winfsp/releases/latest" -UseBasicParsing
    $asset = $release.assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1
    if (-not $asset) {
        throw "Could not find WinFsp MSI installer in latest GitHub release"
    }
    $msiPath = "$env:TEMP\\winfsp.msi"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msiPath -UseBasicParsing
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i \`"$msiPath\`" /qn /norestart" -Wait -PassThru
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
        throw "WinFsp install failed with exit code $($proc.ExitCode)"
    }
    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
    Write-Log "WinFsp installed (exit code $($proc.ExitCode))"
} else {
    Write-Log "WinFsp already installed"
}

# The rclone remote is built on the fly; env_auth pulls credentials from the EC2 instance's own
# IAM role, so editors never see or enter any AWS credentials.
if ($CachePath) {
    if (-not (Test-Path -LiteralPath $CachePath)) { New-Item -Path $CachePath -ItemType Directory -Force | Out-Null }
}
Write-Log "Mount command: $RcloneCmdLine"

# --- Instead of auto-mounting at boot/logon (which this environment's security policy
# blocks for unattended Scheduled Tasks - SeBatchLogonRight is restricted here), create
# Desktop shortcuts so the editor mounts/unmounts this bucket on demand, whenever they
# actually need it. This also means idle workstations aren't burning cycles on mounts
# nobody is using. ---
$ShortcutDir = "C:\\Users\\Public\\Desktop"
$LauncherDir = "C:\\ProgramData\\rclone\\shortcuts"
if (-not (Test-Path $LauncherDir)) { New-Item -Path $LauncherDir -ItemType Directory -Force | Out-Null }

# Mount launcher: a hidden-window VBScript wrapper so double-clicking the shortcut never
# flashes a console window. A quote inside a VBScript string literal is written twice.
$MountLauncherPath = "$LauncherDir\\$TaskName-mount.vbs"
$vbsEscaped = $RcloneCmdLine -replace '"', '""'
$vbsLines = @(
    "Set objShell = CreateObject(\`"WScript.Shell\`")",
    "objShell.Run \`"$vbsEscaped\`", 0, False"
)
Set-Content -Path $MountLauncherPath -Value $vbsLines -Encoding ASCII -Force

# Unmount launcher: a small standalone .ps1 (invoked with -File, no inline quoting needed)
# that stops any rclone process for this specific mount path.
$UnmountScriptPath = "$LauncherDir\\$TaskName-unmount.ps1"
$unmountLines = @(
    'param([string]$MatchPath)',
    'Get-CimInstance -ClassName Win32_Process -Filter "Name=''rclone.exe''" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($MatchPath) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
)
Set-Content -Path $UnmountScriptPath -Value $unmountLines -Encoding ASCII -Force

$WshShell = New-Object -ComObject WScript.Shell

$MountShortcut = $WshShell.CreateShortcut("$ShortcutDir\\Mount $SafeStorageName.lnk")
$MountShortcut.TargetPath = "wscript.exe"
$MountShortcut.Arguments = "\`"$MountLauncherPath\`""
$MountShortcut.Description = "Mount S3 bucket: $BucketName"
$MountShortcut.Save()

$UnmountShortcut = $WshShell.CreateShortcut("$ShortcutDir\\Unmount $SafeStorageName.lnk")
$UnmountShortcut.TargetPath = "powershell.exe"
$UnmountShortcut.Arguments = "-NoProfile -WindowStyle Hidden -File \`"$UnmountScriptPath\`" $UnmountMatchArg"
$UnmountShortcut.Description = "Unmount S3 bucket: $BucketName"
$UnmountShortcut.Save()

Write-Log "Desktop shortcuts created: 'Mount $SafeStorageName' and 'Unmount $SafeStorageName'"

# Clean up artifacts from earlier auto-mount mechanisms no longer used (harmless if absent).
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "$TaskName-boot" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\$TaskName.vbs" -Force -ErrorAction SilentlyContinue

# --- Best-effort: if a user is already logged on interactively right now (e.g. this mount
# was just requested from the MRM web UI while someone is actively using the workstation),
# try mounting immediately too, so they don't have to also click the new Desktop shortcut. ---
$loggedOnUser = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName
if ($loggedOnUser) {
    Write-Log "User already logged on ($loggedOnUser) - attempting immediate mount"
    try {
        Start-Process -FilePath "wscript.exe" -ArgumentList "\`"$MountLauncherPath\`"" -WindowStyle Hidden
        Start-Sleep -Seconds 5
    } catch {
        Write-Log "Immediate mount attempt failed (the Desktop shortcut still works): $_"
    }
} else {
    Write-Log "No interactive user currently logged on - the Desktop shortcut is ready for when they log in"
}

Write-Log "S3 mount setup complete for $BucketName -> $MountPath"
`;
}

/** The PowerShell script that stops the rclone mount and removes the shortcuts and launchers. */
function generateWindowsUnmountScript(storage, taskName) {
  return `$ErrorActionPreference = "Stop"

$MountPath = ${q.ps(storage.mountPath, 'mount path')}
$TaskName = ${q.ps(taskName, 'task name')}
$SafeStorageName = ${q.ps(q.fileName(storage.name, 'storage name'), 'storage name')}

function Write-Log {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

Write-Log "Unmounting S3 storage: $MountPath"

# Terminate any running rclone.exe process mounting this specific path - rclone cleanly
# unmounts via the WinFsp driver when the process exits.
$processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'rclone.exe'" -ErrorAction SilentlyContinue
foreach ($proc in $processes) {
    if ($proc.CommandLine -and $proc.CommandLine.Contains($MountPath)) {
        Write-Log "Stopping rclone process $($proc.ProcessId) for $MountPath"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Remove the on-demand Desktop shortcuts and their launcher files - this is a full teardown,
# used when this bucket is being unassigned from the workstation entirely.
$ShortcutDir = "C:\\Users\\Public\\Desktop"
$LauncherDir = "C:\\ProgramData\\rclone\\shortcuts"

Remove-Item -LiteralPath "$ShortcutDir\\Mount $SafeStorageName.lnk" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$ShortcutDir\\Unmount $SafeStorageName.lnk" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$LauncherDir\\$TaskName-mount.vbs" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$LauncherDir\\$TaskName-unmount.ps1" -Force -ErrorAction SilentlyContinue
Write-Log "Removed Desktop shortcuts and launcher files for $SafeStorageName"

# Clean up artifacts from earlier auto-mount mechanisms no longer used (harmless if absent).
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "$TaskName-boot" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\$TaskName.vbs" -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2
Write-Log "S3 storage unmounted successfully"
`;
}

/** The PowerShell script that reports whether an rclone process holds the mount path. */
function generateWindowsStatusScript(storage, taskName) {
  return `$MountPath = ${q.ps(storage.mountPath, 'mount path')}
$TaskName = ${q.ps(taskName, 'task name')}

$processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'rclone.exe'" -ErrorAction SilentlyContinue
$mounted = $false
foreach ($proc in $processes) {
    if ($proc.CommandLine -and $proc.CommandLine.Contains($MountPath)) {
        $mounted = $true
        break
    }
}

if ($mounted) {
    Write-Output "MOUNTED"
} else {
    Write-Output "NOT_MOUNTED"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Output "SERVICE_ACTIVE"
} else {
    Write-Output "SERVICE_INACTIVE"
}
`;
}

module.exports = {
  LAUNCHER_DIR,
  serviceNameFor,
  linuxLauncher,
  generateMountScript,
  generateUnmountScript,
  generateStatusScript,
  windowsRcloneCommandLine,
  generateWindowsMountScript,
  generateWindowsUnmountScript,
  generateWindowsStatusScript,
};
