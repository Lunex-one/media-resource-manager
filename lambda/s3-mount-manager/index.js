// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 Mount Manager Lambda
 * 
 * Manages Mountpoint for Amazon S3 on Linux workstations.
 * Handles installation, mounting via systemd, and unmounting.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { S3Client, GetBucketLocationCommand } = require('@aws-sdk/client-s3');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Workstations in a Regional Hub live outside this Lambda's home region -
// EC2/SSM clients must be scoped per-request to the workstation's actual region.
function getSsmClient(region) {
    return new SSMClient({ region: region || process.env.AWS_REGION });
}
function getEc2Client(region) {
    return new EC2Client({ region: region || process.env.AWS_REGION });
}

const STORAGE_TABLE_NAME = process.env.STORAGE_TABLE_NAME;
const WORKSTATION_TABLE_NAME = process.env.WORKSTATION_TABLE_NAME;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
    console.log('S3 Mount Manager Event:', JSON.stringify(event, null, 2));
    
    try {
        // Handle API Gateway event format
        let action, instanceId, storageId;
        
        if (event.body) {
            // API Gateway request
            const body = JSON.parse(event.body);
            action = body.action;
            instanceId = body.instanceId;
            storageId = body.storageId;
        } else {
            // Direct invocation
            action = event.action;
            instanceId = event.instanceId;
            storageId = event.storageId;
        }
        
        let result;
        switch (action) {
            case 'mount':
                result = await mountS3Storage(instanceId, storageId);
                break;
            case 'unmount':
                result = await unmountS3Storage(instanceId, storageId);
                break;
            case 'status':
                result = await checkMountStatus(instanceId, storageId);
                break;
            default:
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ success: false, error: `Unknown action: ${action}` })
                };
        }
        
        // Return API Gateway formatted response
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };
        
    } catch (error) {
        console.error('Error in S3 Mount Manager:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                success: false, 
                error: error.message 
            })
        };
    }
};


/**
 * Mount S3 bucket on a workstation using Mountpoint for S3 (Linux) or rclone+WinFsp (Windows)
 */
async function mountS3Storage(instanceId, storageId) {
    console.log(`Mounting S3 storage ${storageId} on instance ${instanceId}`);

    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }

    if (storage.type !== 'mountpoint-s3') {
        throw new Error(`Storage ${storageId} is not a Mountpoint for S3 type`);
    }

    // Get workstation to determine platform
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }

    const platform = workstation.platform?.toLowerCase();
    if (platform !== 'linux' && platform !== 'windows') {
        throw new Error(`S3 mounting only supports Linux and Windows workstations. Instance ${instanceId} is ${workstation.platform}`);
    }

    // Workstations in a Regional Hub live outside this Lambda's home region -
    // EC2/SSM clients must be scoped to the workstation's actual region.
    const region = workstation.region || process.env.AWS_REGION;
    const ec2 = getEc2Client(region);
    const ssm = getSsmClient(region);

    // Verify instance is running
    const instanceInfo = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    }));

    const instance = instanceInfo.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
        throw new Error(`Instance ${instanceId} is not running`);
    }

    // Generate service/task name (sanitized)
    const serviceName = `mountpoint-s3-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // storage.region only records where the storage config was created (always the
    // Lambda's home region), not where the bucket actually lives - rclone (unlike Linux's
    // Mountpoint-S3) needs the real bucket region for S3 v4 signing, so resolve it directly.
    let mountStorage = storage;
    if (platform === 'windows') {
        try {
            const s3 = new S3Client({ region: process.env.AWS_REGION });
            const loc = await s3.send(new GetBucketLocationCommand({ Bucket: storage.bucketName }));
            mountStorage = { ...storage, region: loc.LocationConstraint || 'us-east-1' };
        } catch (err) {
            console.error(`Failed to resolve bucket region for ${storage.bucketName}, falling back to stored region:`, err);
        }
    }

    // Generate the installation and mount script, and pick the right SSM document per platform
    const script = platform === 'windows'
        ? generateWindowsMountScript(mountStorage, serviceName)
        : generateMountScript(storage, serviceName);
    const documentName = platform === 'windows' ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript';

    // Execute via SSM (comment limited to 100 chars)
    const comment = `Mount S3 ${storage.bucketName.substring(0, 40)} - ${storageId.substring(0, 8)}`;
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: comment
    }));

    console.log(`SSM command sent: ${commandResult.Command.CommandId}`);

    // Wait for command to complete (with timeout)
    const result = await waitForCommand(ssm, commandResult.Command.CommandId, instanceId, 120);

    if (result.Status === 'Success') {
        console.log(`Successfully mounted S3 storage ${storageId} on ${instanceId}`);
        return {
            success: true,
            message: `S3 bucket ${storage.bucketName} mounted at ${storage.mountPath}`,
            instanceId,
            storageId,
            mountPath: storage.mountPath
        };
    } else {
        console.error(`Failed to mount S3 storage: ${result.StandardErrorContent}`);
        throw new Error(`Mount failed: ${result.StandardErrorContent || result.Status}`);
    }
}


/**
 * Unmount S3 bucket from a workstation
 */
async function unmountS3Storage(instanceId, storageId) {
    console.log(`Unmounting S3 storage ${storageId} from instance ${instanceId}`);

    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }

    const workstation = await getWorkstationById(instanceId);
    const platform = workstation?.platform?.toLowerCase();
    const region = workstation?.region || process.env.AWS_REGION;
    const ssm = getSsmClient(region);

    // Generate service/task name (sanitized)
    const serviceName = `mountpoint-s3-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;

    let script;
    let documentName;

    if (platform === 'windows') {
        documentName = 'AWS-RunPowerShellScript';
        script = generateWindowsUnmountScript(storage, serviceName);
    } else {
        documentName = 'AWS-RunShellScript';
        script = `#!/bin/bash
set -e

SERVICE_NAME="${serviceName}"
MOUNT_PATH="${storage.mountPath}"
STORAGE_NAME="${storage.name}"

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

# Remove the service file
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$SERVICE_FILE" ]; then
    echo "Removing service file..."
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
fi

# Unmount if still mounted (use lazy unmount to handle busy mounts)
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "Unmounting $MOUNT_PATH..."
    sudo umount -l "$MOUNT_PATH" || true
    sleep 1
fi

# Remove mount directory if empty or stale
if [ -d "$MOUNT_PATH" ]; then
    # Check if it's a stale mount point (transport endpoint not connected)
    if ! mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
        echo "Removing mount directory..."
        sudo rmdir "$MOUNT_PATH" 2>/dev/null || true
    fi
fi

# Remove desktop shortcuts for all users
for USER_HOME in /home/*; do
    DESKTOP_FILE="$USER_HOME/Desktop/$STORAGE_NAME.desktop"
    if [ -f "$DESKTOP_FILE" ]; then
        echo "Removing desktop shortcut: $DESKTOP_FILE"
        rm -f "$DESKTOP_FILE"
    fi
done

echo "S3 storage unmounted successfully"
`;
    }

    // Execute via SSM
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: `Unmount S3 storage ${storageId}`
    }));

    const result = await waitForCommand(ssm, commandResult.Command.CommandId, instanceId, 60);

    if (result.Status === 'Success') {
        return {
            success: true,
            message: `S3 storage unmounted from ${storage.mountPath}`,
            instanceId,
            storageId
        };
    } else {
        throw new Error(`Unmount failed: ${result.StandardErrorContent || result.Status}`);
    }
}


/**
 * Check mount status on a workstation
 */
async function checkMountStatus(instanceId, storageId) {
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }

    const workstation = await getWorkstationById(instanceId);
    const platform = workstation?.platform?.toLowerCase();
    const region = workstation?.region || process.env.AWS_REGION;
    const ssm = getSsmClient(region);

    const serviceName = `mountpoint-s3-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;

    let script;
    let documentName;

    if (platform === 'windows') {
        documentName = 'AWS-RunPowerShellScript';
        script = generateWindowsStatusScript(storage, serviceName);
    } else {
        documentName = 'AWS-RunShellScript';
        script = `#!/bin/bash
MOUNT_PATH="${storage.mountPath}"
SERVICE_NAME="${serviceName}"

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

    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: `Check S3 mount status for ${storageId}`
    }));

    const result = await waitForCommand(ssm, commandResult.Command.CommandId, instanceId, 30);

    const output = result.StandardOutputContent || '';
    const isMounted = output.includes('MOUNTED') && !output.includes('NOT_MOUNTED');
    const serviceActive = output.includes('SERVICE_ACTIVE');

    return {
        success: true,
        instanceId,
        storageId,
        mounted: isMounted,
        serviceActive,
        mountPath: storage.mountPath
    };
}



/**
 * Generate the bash script to install mountpoint and create systemd service
 */
function generateMountScript(storage, serviceName) {
    // Build mount options array
    const mountOptions = [];
    
    // Prefix option
    if (storage.prefix) {
        mountOptions.push(`--prefix "${storage.prefix}"`);
    }
    
    // Access mode
    if (storage.accessMode === 'read-only') {
        mountOptions.push('--read-only');
    }
    
    // Allow delete (only for read-write mode)
    if (storage.accessMode === 'read-write' && storage.allowDelete) {
        mountOptions.push('--allow-delete');
    }
    
    // Allow other users
    if (storage.allowOther) {
        mountOptions.push('--allow-other');
    }
    
    // UID/GID options
    if (storage.uid) {
        mountOptions.push(`--uid ${storage.uid}`);
    }
    if (storage.gid) {
        mountOptions.push(`--gid ${storage.gid}`);
    }
    
    // Cache path
    if (storage.cachePath) {
        mountOptions.push(`--cache "${storage.cachePath}"`);
    }
    
    const mountOptionsStr = mountOptions.join(' ');
    
    return `#!/bin/bash
set -e

BUCKET_NAME="${storage.bucketName}"
MOUNT_PATH="${storage.mountPath}"
SERVICE_NAME="${serviceName}"
MOUNT_OPTIONS="${mountOptionsStr}"

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
sudo mkdir -p "$MOUNT_PATH"

# Enable user_allow_other in fuse.conf for --allow-other to work
if ! grep -q "^user_allow_other" /etc/fuse.conf 2>/dev/null; then
    echo "Enabling user_allow_other in /etc/fuse.conf..."
    echo "user_allow_other" | sudo tee -a /etc/fuse.conf > /dev/null
fi

# Create cache directory if specified
${storage.cachePath ? `
echo "Creating cache directory: ${storage.cachePath}"
sudo mkdir -p "${storage.cachePath}"
` : ''}

# Create systemd service file
echo "Creating systemd service: $SERVICE_NAME"
sudo tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null << EOF
[Unit]
Description=Mountpoint for S3 - ${storage.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/usr/bin/mount-s3 $BUCKET_NAME $MOUNT_PATH $MOUNT_OPTIONS
ExecStop=/usr/bin/umount $MOUNT_PATH
Restart=on-failure
RestartSec=10
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

# Verify mount
sleep 2
if mountpoint -q "$MOUNT_PATH"; then
    echo "SUCCESS: S3 bucket mounted at $MOUNT_PATH"
    echo "Mount options: $MOUNT_OPTIONS"
    ls -la "$MOUNT_PATH" | head -10
    
    # Create desktop shortcut for all users with home directories
    STORAGE_NAME="${storage.name}"
    for USER_HOME in /home/*; do
        if [ -d "$USER_HOME/Desktop" ]; then
            USERNAME=$(basename "$USER_HOME")
            DESKTOP_FILE="$USER_HOME/Desktop/$STORAGE_NAME.desktop"
            echo "Creating desktop shortcut for $USERNAME..."
            cat > "$DESKTOP_FILE" << DESKTOP_EOF
[Desktop Entry]
Type=Link
Name=$STORAGE_NAME
Comment=S3 Mount: $BUCKET_NAME
Icon=folder-remote
URL=$MOUNT_PATH
DESKTOP_EOF
            chown "$USERNAME:$USERNAME" "$DESKTOP_FILE"
            chmod 755 "$DESKTOP_FILE"
        fi
    done
else
    echo "ERROR: Mount verification failed"
    sudo systemctl status "$SERVICE_NAME" --no-pager || true
    exit 1
fi
`;
}


/**
 * Generate the PowerShell script to install rclone+WinFsp and register a Scheduled Task
 * that mounts the S3 bucket as a drive in the logged-on user's own session.
 *
 * Windows session isolation means a drive mounted by a SYSTEM-context service is invisible
 * to the interactive user's Explorer/DCV session - unlike the Linux systemd approach, this
 * can't run as a background service. Instead we register a Scheduled Task with a group-based
 * principal (BUILTIN\Users) and an "At log on" trigger, which runs inside whichever user's
 * session actually logs on, making the mounted drive visible to them.
 */
function generateWindowsMountScript(storage, taskName) {
    const bucketName = storage.bucketName;
    const mountPath = storage.mountPath;
    const prefix = storage.prefix || '';
    const readOnly = storage.accessMode === 'read-only';
    const cachePath = storage.cachePath || '';
    const storageName = storage.name;
    const region = storage.region || process.env.AWS_REGION;

    return `$ErrorActionPreference = "Stop"

$BucketName = "${bucketName}"
$MountPath = "${mountPath}"
$Prefix = "${prefix}"
$ReadOnly = $${readOnly ? 'true' : 'false'}
$CachePath = "${cachePath}"
$StorageName = "${storageName}"
$TaskName = "${taskName}"
$Region = "${region}"

function Write-Log {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

Write-Log "Setting up rclone S3 mount: $BucketName -> $MountPath"

$RcloneDir = "C:\\ProgramData\\rclone"
$RclonePath = "$RcloneDir\\rclone.exe"

# --- Install rclone if not present ---
if (-not (Test-Path $RclonePath)) {
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

# --- Build the rclone remote spec (on-the-fly remote, no persistent config file needed).
# env_auth pulls credentials from the EC2 instance's own IAM role automatically - editors
# never see or enter any AWS credentials. ---
$remotePath = ":s3,provider=AWS,env_auth=true,region=\${Region}:$BucketName"
if ($Prefix) {
    $remotePath = "$remotePath/$Prefix"
}

$mountArgs = @("mount", $remotePath, $MountPath, "--vfs-cache-mode", "writes", "--dir-cache-time", "30s", "--volname", $StorageName)
if ($ReadOnly) {
    $mountArgs += "--read-only"
}
if ($CachePath) {
    if (-not (Test-Path $CachePath)) { New-Item -Path $CachePath -ItemType Directory -Force | Out-Null }
    $mountArgs += @("--cache-dir", $CachePath)
}

$argString = ($mountArgs | ForEach-Object { if ($_ -match '\\s') { "\`"$_\`"" } else { $_ } }) -join ' '
Write-Log "Mount command: $RclonePath $argString"

# --- Instead of auto-mounting at boot/logon (which this environment's security policy
# blocks for unattended Scheduled Tasks - SeBatchLogonRight is restricted here), create
# Desktop shortcuts so the editor mounts/unmounts this bucket on demand, whenever they
# actually need it. This also means idle workstations aren't burning cycles on mounts
# nobody is using. ---
$SafeStorageName = $StorageName -replace '[\\/:*?"<>|]', '_'
$ShortcutDir = "C:\\Users\\Public\\Desktop"
$LauncherDir = "C:\\ProgramData\\rclone\\shortcuts"
if (-not (Test-Path $LauncherDir)) { New-Item -Path $LauncherDir -ItemType Directory -Force | Out-Null }

# Mount launcher: a hidden-window VBScript wrapper so double-clicking the shortcut never
# flashes a console window. This exact wscript.exe + .vbs pattern was verified to work
# reliably by hand before being wired up here.
$MountLauncherPath = "$LauncherDir\\$TaskName-mount.vbs"
$rcloneCmdLine = "\`"$RclonePath\`" $argString"
$vbsEscaped = $rcloneCmdLine -replace '"', '""'
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
    'Get-CimInstance -ClassName Win32_Process -Filter "Name=''rclone.exe''" | Where-Object { $_.CommandLine -like "*$MatchPath*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
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
$UnmountShortcut.Arguments = "-NoProfile -WindowStyle Hidden -File \`"$UnmountScriptPath\`" \`"$MountPath\`""
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


function generateWindowsUnmountScript(storage, taskName) {
    const mountPath = storage.mountPath;
    const storageName = storage.name;

    return `$ErrorActionPreference = "Stop"

$MountPath = "${mountPath}"
$TaskName = "${taskName}"
$StorageName = "${storageName}"

function Write-Log {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

Write-Log "Unmounting S3 storage: $MountPath"

# Terminate any running rclone.exe process mounting this specific path - rclone cleanly
# unmounts via the WinFsp driver when the process exits.
$processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'rclone.exe'" -ErrorAction SilentlyContinue
foreach ($proc in $processes) {
    if ($proc.CommandLine -like "*$MountPath*") {
        Write-Log "Stopping rclone process $($proc.ProcessId) for $MountPath"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Remove the on-demand Desktop shortcuts and their launcher files - this is a full teardown,
# used when this bucket is being unassigned from the workstation entirely.
$SafeStorageName = $StorageName -replace '[\\/:*?"<>|]', '_'
$ShortcutDir = "C:\\Users\\Public\\Desktop"
$LauncherDir = "C:\\ProgramData\\rclone\\shortcuts"

Remove-Item -Path "$ShortcutDir\\Mount $SafeStorageName.lnk" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$ShortcutDir\\Unmount $SafeStorageName.lnk" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$LauncherDir\\$TaskName-mount.vbs" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$LauncherDir\\$TaskName-unmount.ps1" -Force -ErrorAction SilentlyContinue
Write-Log "Removed Desktop shortcuts and launcher files for $StorageName"

# Clean up artifacts from earlier auto-mount mechanisms no longer used (harmless if absent).
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "$TaskName-boot" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\$TaskName.vbs" -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2
Write-Log "S3 storage unmounted successfully"
`;
}


function generateWindowsStatusScript(storage, taskName) {
    const mountPath = storage.mountPath;

    return `$MountPath = "${mountPath}"
$TaskName = "${taskName}"

$processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'rclone.exe'" -ErrorAction SilentlyContinue
$mounted = $false
foreach ($proc in $processes) {
    if ($proc.CommandLine -like "*$MountPath*") {
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

/**
 * Get storage configuration by ID
 */
async function getStorageById(storageId) {
    const result = await dynamodb.send(new GetCommand({
        TableName: STORAGE_TABLE_NAME,
        Key: { storageId }
    }));
    return result.Item;
}

/**
 * Get workstation by instance ID
 */
async function getWorkstationById(instanceId) {
    const result = await dynamodb.send(new GetCommand({
        TableName: WORKSTATION_TABLE_NAME,
        Key: { instanceId }
    }));
    return result.Item;
}

/**
 * Wait for SSM command to complete
 */
async function waitForCommand(ssm, commandId, instanceId, timeoutSeconds = 120) {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const result = await ssm.send(new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: instanceId
            }));
            
            if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(result.Status)) {
                return result;
            }
            
            // Wait before polling again
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            if (error.name === 'InvocationDoesNotExist') {
                // Command not yet registered, wait and retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Command ${commandId} timed out after ${timeoutSeconds} seconds`);
}
