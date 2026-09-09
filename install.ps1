# Coen 1 CLI installer — Windows.
#
#   irm https://raw.githubusercontent.com/adamnlynn/-coen1-cli/main/install.ps1 | iex
#
# What it does, in order:
#   1. Finds a Node 22+ to run with. If there isn't one, downloads an official build from
#      nodejs.org into this install's own directory and checks its SHA-256. Your system Node,
#      if you have one, is never touched or upgraded.
#   2. Installs @coen1/cli from npm into %LOCALAPPDATA%\coen — a private prefix, so this never
#      needs an administrator and never writes to Program Files.
#   3. Drops a `coen.cmd` launcher in %LOCALAPPDATA%\coen\bin and puts that on your user PATH.
#
# Uninstall is: Remove-Item -Recurse "$env:LOCALAPPDATA\coen"  (then tidy your user PATH).
#
# Env:
#   COEN_VERSION      version to install (default: latest)
#   COEN_INSTALL_DIR  where everything lives (default: %LOCALAPPDATA%\coen)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Pkg           = '@coen1/cli'
$NodeFallback  = 'v24.21.0'   # only used when no suitable Node is already installed
$MinNodeMajor  = 22

$InstallDir = if ($env:COEN_INSTALL_DIR) { $env:COEN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'coen' }
$BinDir     = Join-Path $InstallDir 'bin'

function Step($m) { Write-Host "> $m" -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "OK $m" -ForegroundColor Green }
function Die($m)  { Write-Host "x  $m" -ForegroundColor Red; exit 1 }

# ── Which machine is this ────────────────────────────────────────────────────
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  'x86'   { Die 'Coen needs 64-bit Windows.' }
  default { Die "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}
Step "windows-$arch"

# ── A Node to run with ───────────────────────────────────────────────────────
# Prefer one this installer put there before, then the system's, and only download as a last
# resort. Checking the system's first means a normal machine installs in seconds with no download.
function Get-NodeMajor($exe) {
  try { $v = & $exe -v 2>$null; if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } } catch { }
  return 0
}

$Node = $null
$ownNode = Join-Path $InstallDir 'node\node.exe'
if (Test-Path $ownNode) {
  $Node = $ownNode
} else {
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) {
    $maj = Get-NodeMajor $sys.Source
    if ($maj -ge $MinNodeMajor) {
      $Node = $sys.Source
      Step "using your Node $(& $Node -v)"
    } else {
      Step "your Node v$maj is older than v$MinNodeMajor - leaving it alone"
    }
  }
}

if (-not $Node) {
  $tarball = "node-$NodeFallback-win-$arch.zip"
  $base    = "https://nodejs.org/dist/$NodeFallback"
  $tmp     = Join-Path ([System.IO.Path]::GetTempPath()) ("coen-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Step "downloading Node $NodeFallback (private to this install)"
    $zip = Join-Path $tmp $tarball
    Invoke-WebRequest -Uri "$base/$tarball" -OutFile $zip -UseBasicParsing

    # Verified, always. An installer that pipes an unverified download into your shell is the
    # thing people are right to be suspicious of.
    Step 'verifying checksum'
    $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $want = ($sums -split "`n" | Where-Object { $_ -match "\s\Q$tarball\E$" } |
             ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1)
    if (-not $want) { Die "no checksum published for $tarball" }
    $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($want.ToLower() -ne $got) {
      Die "checksum mismatch for $tarball - refusing to install.`n  expected $want`n  got      $got"
    }
    Ok 'checksum verified'

    $nodeDir = Join-Path $InstallDir 'node'
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Move-Item (Join-Path $tmp "node-$NodeFallback-win-$arch") $nodeDir
    $Node = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $Node)) { Die 'Node did not extract correctly' }
    Ok "Node $NodeFallback installed to $nodeDir"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# ── The package ──────────────────────────────────────────────────────────────
# Into our own prefix rather than the system one: no administrator, and uninstalling is deleting
# a directory.
$spec = if ($env:COEN_VERSION) { "$Pkg@$($env:COEN_VERSION)" } else { $Pkg }
Step "installing $spec"
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

$npmCli = Join-Path (Split-Path $Node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { Die "npm was not found next to $Node" }
& $Node $npmCli install -g --prefix "$InstallDir" $spec 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Die "npm install failed. Re-run by hand:`n  & `"$Node`" `"$npmCli`" install -g --prefix `"$InstallDir`" $spec"
}

# npm --prefix on Windows puts packages under <prefix>\node_modules, not \lib\node_modules.
$entry = Join-Path $InstallDir "node_modules\$($Pkg -replace '/','\')\dist\index.js"
if (-not (Test-Path $entry)) {
  $entry = Join-Path $InstallDir "lib\node_modules\$($Pkg -replace '/','\')\dist\index.js"
}
if (-not (Test-Path $entry)) { Die "installed, but the package entry point was not where expected." }

# ── The launcher ─────────────────────────────────────────────────────────────
# A .cmd rather than the .ps1 shim npm writes, so `coen` works identically from cmd.exe,
# PowerShell and Windows Terminal. Falls back to a Node on PATH if the recorded one is removed.
$launcher = @"
@echo off
setlocal
set "COEN_NODE=$Node"
if not exist "%COEN_NODE%" (
  for %%I in (node.exe) do set "COEN_NODE=%%~`$PATH:I"
)
if not exist "%COEN_NODE%" (
  echo coen: the Node this was installed with is gone, and none is on PATH. 1>&2
  echo        Reinstall: irm https://raw.githubusercontent.com/adamnlynn/-coen1-cli/main/install.ps1 ^| iex 1>&2
  exit /b 1
)
"%COEN_NODE%" "$entry" %*
"@
Set-Content -Path (Join-Path $BinDir 'coen.cmd') -Value $launcher -Encoding ASCII

& (Join-Path $BinDir 'coen.cmd') --help > $null 2>&1
if ($LASTEXITCODE -ne 0) { Die "installed, but 'coen --help' did not run cleanly." }
Ok 'Coen 1 CLI installed'

# ── PATH ─────────────────────────────────────────────────────────────────────
# User scope, so this never needs an administrator. Done rather than merely suggested, because
# telling a Windows user to edit their PATH by hand is where an install stops being one line.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $BinDir } else { "$userPath;$BinDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Ok "added $BinDir to your user PATH (open a new terminal to pick it up)"
}
$env:Path = "$env:Path;$BinDir"

Write-Host ''
Write-Host '  Next:  coen login      (it will offer to make you a free account)'
Write-Host '         coen            (Home)'
Write-Host ''
