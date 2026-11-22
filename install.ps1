# Install VerdictLite (vlite) on Windows, in one step.
#
# One line (no copy of the repo needed):
#   powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://github.com/scottconverse/verdictlite/releases/latest/download/install.ps1 | iex"
# Or double-click install-verdictlite.cmd from the release page.
#
# What it does, in order:
#   1. Checks for Node.js 20 or newer. Installs it with winget (for this user only) when it is missing.
#   2. Downloads verdictlite.zip and verdictlite.zip.sha256 from the GitHub release and checks the SHA-256.
#   3. Puts the files in one fixed folder (default %LOCALAPPDATA%\VerdictLite\app). An old install is
#      replaced only after the new files are ready. The folder stays the same on every update,
#      because git hooks keep its path.
#   4. Writes %LOCALAPPDATA%\VerdictLite\bin\vlite.cmd and adds that bin folder to your user PATH.
#   5. Runs vlite --help to prove it works.
#   6. Runs vlite connect on a TRUE first install only. It adds the VerdictLite Stop hook to the Claude Code and
#      Codex desktop apps (user level). It is not a first install, and connect is not run, when dist\cli.js is
#      already in the install folder, or the VerdictLite home folder exists (VLITE_HOME, else
#      %USERPROFILE%\.verdictlite), or vlite connect --uninstall left its connect-off.json marker there.
#      Use -NoConnect to skip it always, or -Connect to force it.
#
# Nothing needs administrator rights. Runs on Windows PowerShell 5.1 and PowerShell 7.
# Run it again at any time to update.

[CmdletBinding()]
param(
    # A release to install, for example 0.1.7. The default is the latest release.
    [string]$Version = '',
    # The fixed folder for the program files. vlite.cmd goes in the bin folder next to it.
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'VerdictLite\app'),
    # Use this local zip (with its .sha256 file next to it) instead of downloading. For tests.
    [string]$ZipPath = '',
    # Do not change the user PATH.
    [switch]$NoPath,
    # Do not connect VerdictLite to the Claude Code and Codex desktop apps.
    [switch]$NoConnect,
    # Run vlite connect even when this is not a first install. Without it, the current connect state is kept.
    [switch]$Connect,
    # Print the steps and change nothing.
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Step([string]$text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "   ok: $text" -ForegroundColor Green }
function Note([string]$text) { Write-Host "   $text" }

function Have([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# PATH as the user and machine have it now, so a tool installed a moment ago is found.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    # Machine, then user, then what this session already has. Empty entries and repeats go, so a second run
    # in the same PowerShell does not double PATH. Same entry = same text without case, edge spaces or a
    # trailing slash. The first spelling stays. The user and machine PATH are only read, never changed.
    $seen = @{}
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($entry in (@($machine, $user, $env:Path) -join ';') -split ';') {
        $key = $entry.Trim().TrimEnd('\', '/').ToLowerInvariant()
        if (-not $key -or $seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $kept.Add($entry.Trim())
    }
    $env:Path = $kept -join ';'
}

function Add-UserPath([string]$dir) {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($user -split ';' | Where-Object { $_ })
    if ($parts -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
    }
    if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
}

# The major version of Node.js on PATH, or 0 when there is none.
function Get-NodeMajor {
    if (-not (Have 'node')) { return 0 }
    $v = (& node --version) 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

$steps = @(
    'Check Node.js 20 or newer (install it with winget when missing)',
    'Download verdictlite.zip and check its SHA-256',
    'Put the files in the install folder',
    'Write vlite.cmd and add its folder to the user PATH',
    'Run vlite --help to check it works',
    'Connect VerdictLite to the Claude and Codex desktop apps (true first install only; -Connect forces it)'
)
if ($PlanOnly) {
    $i = 1
    foreach ($s in $steps) { Write-Output "$i. $s"; $i++ }
    return
}

if ($Version) { $Base = "https://github.com/scottconverse/verdictlite/releases/download/v$($Version.TrimStart('v'))" }
else { $Base = 'https://github.com/scottconverse/verdictlite/releases/latest/download' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$BinDir = Join-Path (Split-Path -Parent $InstallDir) 'bin'
if ($NoConnect -and $Connect) { throw '-NoConnect and -Connect cannot be used together.' }
# Is this a true first install? Decided here, before anything is written. It is NOT a first install when
# VerdictLite is already in the install folder, its home folder exists, or a disconnect marker is there.
$vliteHome = if ($env:VLITE_HOME) { $env:VLITE_HOME } else { Join-Path $env:USERPROFILE '.verdictlite' }
$notFirst = ''
if (Test-Path (Join-Path $InstallDir 'dist/cli.js')) { $notFirst = 'update' }
elseif (Test-Path (Join-Path $vliteHome 'connect-off.json')) { $notFirst = 'marker' }
elseif (Test-Path $vliteHome) { $notFirst = 'home' }
$connectRan = $false

# 1. Node.js
Step $steps[0]
Update-SessionPath
$major = Get-NodeMajor
if ($major -lt 20) {
    if (-not (Have 'winget')) {
        throw "Node.js 20 or newer is needed and winget is not here. Install Node.js from https://nodejs.org/ and run this again."
    }
    Note "installing Node.js LTS with winget (this user only)"
    & winget install --id OpenJS.NodeJS.LTS --scope user -e --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    $major = Get-NodeMajor
    if ($major -lt 20) {
        throw "Node.js 20 or newer is still not found after winget. Install it from https://nodejs.org/, open a new terminal, and run this again."
    }
}
Ok "Node.js $((& node --version))"

# 2. Download and check
Step $steps[1]
$work = Join-Path ([IO.Path]::GetTempPath()) ("verdictlite-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
    if ($ZipPath) {
        $zip = (Resolve-Path $ZipPath).Path
        $shaFile = "$zip.sha256"
        if (-not (Test-Path $shaFile)) { throw "No checksum file next to the zip: $shaFile" }
        Note "using the local zip $zip"
    } else {
        $zip = Join-Path $work 'verdictlite.zip'
        $shaFile = Join-Path $work 'verdictlite.zip.sha256'
        Note "downloading $Base/verdictlite.zip"
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/verdictlite.zip" -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/verdictlite.zip.sha256" -OutFile $shaFile
    }
    $expected = ((Get-Content -Raw $shaFile).Trim() -split '\s+')[0].ToLowerInvariant()
    # .NET, not Get-FileHash: Windows PowerShell started from PowerShell 7 cannot load that module.
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($zip)
    try { $actual = (-join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })) } finally { $stream.Dispose(); $sha.Dispose() }
    if ($expected -ne $actual) {
        throw "SHA-256 does not match. Expected $expected but the zip is $actual. Nothing was installed."
    }
    Ok "SHA-256 $actual"

    # 3. Files. Unpack to a folder next to the install folder first; swap only when that worked.
    Step $steps[2]
    New-Item -ItemType Directory -Force (Split-Path -Parent $InstallDir) | Out-Null
    $fresh = "$InstallDir.new"
    $old = "$InstallDir.old"
    foreach ($p in @($fresh, $old)) { if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
    # .NET, not Expand-Archive, for the same reason as the SHA-256 above.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $fresh)
    if (-not (Test-Path (Join-Path $fresh 'dist\cli.js'))) { throw 'The zip has no dist\cli.js. Nothing was installed.' }
    $hadOld = Test-Path $InstallDir
    if ($hadOld) { Move-Item -Path $InstallDir -Destination $old }
    try {
        Move-Item -Path $fresh -Destination $InstallDir
    } catch {
        if ($hadOld) { Move-Item -Path $old -Destination $InstallDir }
        throw
    }
    if ($hadOld) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
    Ok "files in $InstallDir"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

# 4. vlite.cmd and PATH
Step $steps[3]
New-Item -ItemType Directory -Force $BinDir | Out-Null
$cmdFile = Join-Path $BinDir 'vlite.cmd'
$cmdText = "@node `"$(Join-Path $InstallDir 'dist\cli.js')`" %*`r`n"
$enc = [Text.Encoding]::ASCII
if ($cmdText -match '[^\x00-\x7F]') {
    # cmd.exe reads the file in the OEM code page.
    try {
        $oem = [int](Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage').OACP
        $enc = [Text.Encoding]::GetEncoding($oem)
    } catch { $enc = [Text.Encoding]::Default }
}
[IO.File]::WriteAllText($cmdFile, $cmdText, $enc)
Ok "wrote $cmdFile"
if ($NoPath) {
    Note "-NoPath: the user PATH was not changed"
} else {
    Add-UserPath $BinDir
    Ok "$BinDir is on your user PATH"
}

# 5. Prove it
Step $steps[4]
# Read ALL the output first. Select-Object -First 1 would stop node early, and
# Windows PowerShell 5.1 then keeps exit code -1 in $LASTEXITCODE.
$helpOut = @(& $cmdFile --help 2>&1)
if ($LASTEXITCODE -ne 0) { throw "vlite --help failed with exit code $LASTEXITCODE" }
$first = ($helpOut | Select-Object -First 1) | Out-String
if ($first -notmatch 'VerdictLite') { throw "vlite --help did not work. First line: $first" }
$installed = (Get-Content -Raw (Join-Path $InstallDir 'package.json') | ConvertFrom-Json).version
Ok "$($first.Trim())"
Ok "VerdictLite $installed is installed"

# 6. Connect the desktop apps
Step $steps[5]
if ($NoConnect) {
    Note "-NoConnect: the Claude and Codex apps were not changed"
} elseif ($notFirst -and -not $Connect) {
    if ($notFirst -eq 'update') { Note "This is an update, so I kept your current connect state and did not run vlite connect. Use -Connect to connect." }
    elseif ($notFirst -eq 'marker') { Note "You disconnected VerdictLite on purpose ($(Join-Path $vliteHome 'connect-off.json')), so I did not run vlite connect. Use -Connect to connect again." }
    else { Note "The VerdictLite home folder $vliteHome already exists, so this is not a first install. I kept your current connect state and did not run vlite connect. Use -Connect to connect." }
} else {
    if ($notFirst) { Note "-Connect: running vlite connect (this is not a first install)" } else { Note "First install: running vlite connect" }
    # Read ALL the output first, for the same reason as above.
    $connectOut = @(& $cmdFile connect 2>&1)
    $connectCode = $LASTEXITCODE
    foreach ($line in $connectOut) {
        $text = ($line | Out-String).TrimEnd()
        if ($text -match 'connected|already|removed') { Ok $text } else { Note $text }
    }
    if ($connectCode -ne 0) { throw "vlite connect failed with exit code $connectCode" }
    $connectRan = $true
}

Write-Host ""
Write-Host "Next steps" -ForegroundColor Cyan
$n = 1
if ($connectRan) {
    Note "$n. Restart the Claude and Codex apps."; $n++
    Note "$n. In Codex, approve the hook: click Review hooks, or open Settings > Hooks."; $n++
}
Note "$n. In each repo you want to guard, ask the agent to write vlite.json, then run:  vlite install"
Note "   How to write vlite.json: https://github.com/scottconverse/verdictlite/blob/main/docs/manual.md#3-set-up-a-repo"
Note "To update later, run this installer again."
