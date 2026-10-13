// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The FSx logon script and the SSM commands that install it, as pure functions of the records.
//
// The logon script runs at every user's logon on a Windows workstation, and the commands that
// write it run as SYSTEM. Every value from a storage record, a workstation's storage config, a
// secret or an AWS answer reaches them through `script-quote.js`: a storage name, a drive letter
// and a share name are written by an admin through the API, and until this module they were
// pasted into PowerShell comments and double-quoted strings, where a newline starts a new
// statement and `$(...)` runs. Kept apart from `index.js` so a test can read the scripts without
// AWS clients.
//
// The rules the generators below keep:
// - a value is assigned once, as a single-quoted literal (`q.ps`), and only its variable is used
//   after that; PowerShell does not re-read what a variable expands to;
// - no value is ever written into a comment;
// - a drive letter is validated to one letter (`q.driveLetter`), because `net use Z:` reads it
//   as a bare word;
// - the logon script reaches the workstation base64-encoded, so nothing in it can end the string
//   that carries it.

const q = require('./script-quote');

/** The PowerShell literal for a UNC path `\\host\share`. */
function uncPath(host, share) {
  return q.ps(`\\\\${q.plain(host, 'file server name')}\\${q.plain(share, 'share name')}`, 'network path');
}

/** The lines every mount block opens with: the values it uses, each a literal. */
function mountValues(storage, networkPath) {
  return `    $mountName = ${q.ps(storage.name, 'storage name')}
    $networkPath = ${networkPath}`;
}

/** Records the mapping in the registry so Explorer shows the drive as connected and labelled. */
function registryFix(letter, username) {
  return `        # Fix "Disconnected Network Drive" display issue with comprehensive registry fix
        $regPath = "HKCU:\\Network\\${letter}"
        if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "RemotePath" -Value $networkPath
        Set-ItemProperty -Path $regPath -Name "UserName" -Value ${username}
        Set-ItemProperty -Path $regPath -Name "ProviderName" -Value "Microsoft Windows Network"
        Set-ItemProperty -Path $regPath -Name "ProviderType" -Value 0x20000 -Type DWord
        Set-ItemProperty -Path $regPath -Name "ConnectionType" -Value 1 -Type DWord
        Set-ItemProperty -Path $regPath -Name "DeferFlags" -Value 4 -Type DWord

        # Set custom label for network drive in Explorer
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value $mountName`;
}

function generateLoginScript(storageConfig, isDomainJoined, credentials, domainName, ontapCredentialsMap = {}) {
    // `isDomainJoined` arrived as whatever the workstation record held - a domain id string where
    // one was set - and was printed into the script. Only true or false is written now.
    const joined = Boolean(isDomainJoined);
    const mountCommands = storageConfig.map(storage => {
        const driveLetter = q.driveLetter(storage.driveLetter || 'Z');

        // Handle FSxN storage type
        if (storage.type === 'fsx-ontap') {
            // Get credentials for this specific storage
            const ontapCredentials = ontapCredentialsMap[storage.storageId] || null;
            return generateFsxOntapMountCommand(storage, driveLetter, ontapCredentials);
        }

        // Handle FSx Windows storage type
        const fsxDnsName = storage.fsxDnsName;
        const shareName = 'share';

        if (joined) {
            // Domain-joined: use integrated Windows authentication
            return generateDomainJoinedMountCommand(storage, driveLetter, fsxDnsName, shareName);
        } else {
            // Non-domain-joined: use explicit credentials
            return generateStandaloneMountCommand(storage, driveLetter, fsxDnsName, shareName, credentials, domainName);
        }
    }).join('\n');

    return `# FSx Storage Mount Script - Auto-generated
# This script runs at user login to mount FSx file systems
# Generated on: $(Get-Date)
# Domain-joined: ${joined}

# Set execution policy for this session
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

# Log file
$logFile = "C:\\Windows\\Temp\\fsx-mount-log.txt"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

try {
    Add-Content -Path $logFile -Value "[$timestamp] Starting FSx mount for user: $env:USERNAME (Domain-joined: ${joined})"

    # Clear any existing FSx network drive mappings to prevent conflicts
    Add-Content -Path $logFile -Value "[$timestamp] Clearing existing FSx network drive mappings"
    $existingDrives = net use | Select-String "\\\\.*\\.(studio|fsx)\\."
    foreach ($drive in $existingDrives) {
        $driveLetter = ($drive -split "\\s+")[1]
        if ($driveLetter -match "^[A-Z]:$") {
            net use $driveLetter /delete /y 2>$null
            Add-Content -Path $logFile -Value "[$timestamp] Removed existing mapping: $driveLetter"
        }
    }

    ${mountCommands}

    Add-Content -Path $logFile -Value "[$timestamp] FSx mount completed successfully for user: $env:USERNAME"

    # Minimal refresh - just notify shell of drive changes (non-disruptive)
    Add-Content -Path $logFile -Value "[$timestamp] Refreshing drive display"
    rundll32.exe shell32.dll,SHChangeNotify 0x8000000,0x1000,0,0

    Write-Host "FSx mount script completed. Check $logFile for details."

} catch {
    $errorMsg = "FSx mount script failed: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: $errorMsg"
    Write-Error $errorMsg
}
`;
}

function generateDomainJoinedMountCommand(storage, driveLetter, fsxDnsName, shareName) {
    return `
# Mount an FSx volume to ${driveLetter}: (Domain-joined - using integrated auth)
try {
${mountValues(storage, uncPath(fsxDnsName, shareName))}

    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null

    # Mount using net use with integrated Windows authentication
    $result = net use ${driveLetter}: $networkPath /persistent:yes

    if ($LASTEXITCODE -eq 0) {
${registryFix(driveLetter, "''")}

        Write-Host "Successfully mounted $mountName to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted $mountName to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }

} catch {
    Write-Warning "Failed to mount $mountName to ${driveLetter}: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount $($mountName): $_"
}`;
}

function generateStandaloneMountCommand(storage, driveLetter, fsxDnsName, shareName, credentials, domainName) {
    if (!credentials || !domainName) {
        return `
# Mount an FSx volume to ${driveLetter}: (Standalone - CREDENTIALS NOT AVAILABLE)
$mountName = ${q.ps(storage.name, 'storage name')}
Write-Warning "Cannot mount $mountName - AD credentials not configured for standalone workstation"
Add-Content -Path $logFile -Value "[$timestamp] ERROR: Cannot mount $mountName - AD credentials not available for standalone workstation"`;
    }

    // For standalone workstations, we need to use explicit credentials
    // The credentials are embedded in the script - this is stored securely on the workstation
    const username = `${q.plain(domainName, 'domain name')}\\${q.plain(credentials.username, 'AD user name')}`;

    return `
# Mount an FSx volume to ${driveLetter}: (Standalone - using explicit credentials)
try {
${mountValues(storage, uncPath(fsxDnsName, shareName))}
    $username = ${q.ps(username, 'AD user name')}
    $password = ${q.ps(credentials.password, 'AD password')}

    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null

    # Mount using net use with explicit credentials
    $result = net use ${driveLetter}: $networkPath /user:$username $password /persistent:yes

    if ($LASTEXITCODE -eq 0) {
${registryFix(driveLetter, '$username')}

        Write-Host "Successfully mounted $mountName to ${driveLetter}: ($networkPath) using explicit credentials"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted $mountName to ${driveLetter}: (standalone mode)"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }

} catch {
    Write-Warning "Failed to mount $mountName to ${driveLetter}: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount $($mountName): $_"
}`;
}

/**
 * Generate mount command for FSx for NetApp ONTAP (SMB on Windows)
 * FSxN uses SVM DNS name and share name for mounting
 */
function generateFsxOntapMountCommand(storage, driveLetter, ontapCredentials) {
    // FSxN mount path: \\svm-dns-name\share-name
    const svmDnsName = storage.svmDnsName || storage.fsxDnsName;
    // Use share name from credentials (set by configure-ontap-cifs), or fall back to vol1
    const shareName = ontapCredentials?.shareName || storage.shareName || 'vol1';

    if (!svmDnsName) {
        return `
# Mount an FSxN volume to ${driveLetter}: (FSxN - SVM DNS NAME NOT AVAILABLE)
$mountName = ${q.ps(storage.name, 'storage name')}
Write-Warning "Cannot mount $mountName - SVM DNS name not available"
Add-Content -Path $logFile -Value "[$timestamp] ERROR: Cannot mount $mountName - SVM DNS name not available"`;
    }

    // If we have ONTAP credentials, use them; otherwise try without credentials (guest access)
    if (ontapCredentials && ontapCredentials.username && ontapCredentials.password) {
        return `
# Mount an FSxN volume to ${driveLetter}: (FSxN - using ONTAP local user)
try {
${mountValues(storage, uncPath(svmDnsName, shareName))}
    $username = ${q.ps(ontapCredentials.username, 'ONTAP user name')}
    $password = ${q.ps(ontapCredentials.password, 'ONTAP password')}

    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null

    # Mount using net use with ONTAP local user credentials
    $result = net use ${driveLetter}: $networkPath /user:$username $password /persistent:yes

    if ($LASTEXITCODE -eq 0) {
${registryFix(driveLetter, '$username')}

        Write-Host "Successfully mounted $mountName (FSxN) to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted $mountName (FSxN) to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }

} catch {
    Write-Warning "Failed to mount $mountName (FSxN) to ${driveLetter}: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount $mountName (FSxN): $_"
}`;
    } else {
        // Try without credentials - may work if guest access is enabled or user is prompted
        return `
# Mount an FSxN volume to ${driveLetter}: (FSxN - no stored credentials)
try {
${mountValues(storage, uncPath(svmDnsName, shareName))}

    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null

    # Try to mount - Windows may prompt for credentials or use cached credentials
    $result = net use ${driveLetter}: $networkPath /persistent:yes

    if ($LASTEXITCODE -eq 0) {
${registryFix(driveLetter, "''")}

        Write-Host "Successfully mounted $mountName (FSxN) to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted $mountName (FSxN) to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE - credentials may be required"
    }

} catch {
    Write-Warning "Failed to mount $mountName (FSxN) to ${driveLetter}: $_ - You may need to configure ONTAP credentials"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount $mountName (FSxN): $_ - ONTAP credentials may be required"
}`;
    }
}

/**
 * The SSM commands that write the logon script and trigger it.
 *
 * The script travels base64-encoded and is decoded on the workstation. It used to be pasted into
 * a single-quoted here-string, `@'` ... `'@`, which a line beginning `'@` inside any value ended -
 * and the rest of that value then ran as SYSTEM.
 */
function deployCommands(scriptContent) {
    const encoded = Buffer.from(scriptContent, 'utf8').toString('base64');
    return [
        '# Deploy FSx Login Script',
        'if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {',
        '    Write-Error "This script requires Administrator privileges"',
        '    exit 1',
        '}',
        '',
        '# Create login script directory',
        '$scriptPath = "C:\\Windows\\System32\\GroupPolicy\\User\\Scripts\\Logon"',
        'if (!(Test-Path $scriptPath)) {',
        '    New-Item -Path $scriptPath -ItemType Directory -Force',
        '}',
        '',
        '# Write the FSx mount script',
        '$scriptFile = "$scriptPath\\MountFsxStorage.ps1"',
        `$scriptContent = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        '$scriptContent | Out-File $scriptFile -Encoding UTF8',
        '',
        '# Trigger the scheduled task to run immediately for current user',
        'try {',
        '    Start-ScheduledTask -TaskName "FSxMountScript" -ErrorAction SilentlyContinue',
        '    Write-Host "Triggered FSx mount script to run immediately"',
        '} catch {',
        '    Write-Host "Could not trigger scheduled task (may not exist yet): $_"',
        '}',
        '',
        'Write-Host "FSx login script deployed successfully to $scriptFile"'
    ];
}

module.exports = {
    generateLoginScript,
    generateDomainJoinedMountCommand,
    generateStandaloneMountCommand,
    generateFsxOntapMountCommand,
    deployCommands,
};
