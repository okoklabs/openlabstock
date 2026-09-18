[CmdletBinding()]
param(
  [ValidateSet('menu', 'update', 'backup', 'rollback', 'status', 'prune')]
  [string]$Action = 'menu'
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path (Join-Path $scriptRoot '..\..')).Path
$configDirectory = Join-Path $env:LOCALAPPDATA 'OpenLabStock'
$configPath = Join-Path $configDirectory 'operations.json'

function Stop-WithMessage([string]$Message) {
  Write-Host "`nERROR: $Message" -ForegroundColor Red
  if ($Host.Name -notmatch 'ServerHost') { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Stop-WithMessage "Required command not found: $Name. Install Windows OpenSSH Client."
  }
}

function Get-Config {
  $defaults = [ordered]@{
    target = ''
    port = 22
    appDir = '/opt/openlabstock'
    serviceName = 'openlabstock'
    dataDir = '/var/lib/openlabstock'
    envFile = '/etc/openlabstock/openlabstock.env'
    backupDir = '/var/lib/openlabstock/backups'
    updateScript = '/usr/local/sbin/openlabstock-update'
    publicHealthUrl = ''
  }
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try {
      $saved = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      foreach ($key in $defaults.Keys) {
        $property = $saved.PSObject.Properties[$key]
        if ($null -ne $property -and $null -ne $property.Value) { $defaults[$key] = $property.Value }
      }
    } catch {
      Write-Host "Saved configuration could not be read; using defaults." -ForegroundColor Yellow
    }
  }
  return [pscustomobject]$defaults
}

function Save-Config($Config) {
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  $Config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
}

function Read-Value([string]$Label, [string]$Current, [bool]$Required = $true) {
  $suffix = if ($Current) { " [$Current]" } else { '' }
  $value = Read-Host "$Label$suffix"
  if ([string]::IsNullOrWhiteSpace($value)) { $value = $Current }
  if ($Required -and [string]::IsNullOrWhiteSpace($value)) { Stop-WithMessage "$Label is required." }
  return $value.Trim()
}

function Assert-SafeTarget([string]$Value) {
  if ($Value -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9._:-]*$') { Stop-WithMessage 'SSH target must look like user@host and contain no shell characters.' }
}

function Assert-SafeRemotePath([string]$Value, [string]$Label) {
  if ($Value -notmatch '^/[A-Za-z0-9._/@-]+$') { Stop-WithMessage "$Label must be an absolute path without shell characters." }
}

function Get-RemoteConfig {
  $config = Get-Config
  $config.target = Read-Value 'SSH target (user@host)' ([string]$config.target)
  if ($config.target -notmatch '@') {
    if ($config.target -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$') { Stop-WithMessage 'Host or IP contains unsafe characters.' }
    $config.target = "root@$($config.target)"
    Write-Host "Using root@$($config.target.Split('@')[-1]) as the SSH target." -ForegroundColor Yellow
  }
  Assert-SafeTarget $config.target
  $portText = Read-Value 'SSH port' ([string]$config.port)
  $port = 0
  if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { Stop-WithMessage 'SSH port must be between 1 and 65535.' }
  $config.port = $port
  foreach ($entry in @(
    @{ Key = 'appDir'; Label = 'Application directory' },
    @{ Key = 'serviceName'; Label = 'systemd service name' },
    @{ Key = 'dataDir'; Label = 'Data directory' },
    @{ Key = 'envFile'; Label = 'Environment file' },
    @{ Key = 'backupDir'; Label = 'Backup directory' },
    @{ Key = 'updateScript'; Label = 'Update script path' }
  )) {
    $value = Read-Value $entry.Label ([string]$config.($entry.Key))
    if ($entry.Key -eq 'serviceName') {
      if ($value -notmatch '^[A-Za-z0-9_.@-]+$') { Stop-WithMessage 'Service name contains unsafe characters.' }
    } else { Assert-SafeRemotePath $value $entry.Label }
    $config.($entry.Key) = $value
  }
  $config.publicHealthUrl = Read-Value 'Public health URL (optional)' ([string]$config.publicHealthUrl) $false
  if ($config.publicHealthUrl -and $config.publicHealthUrl -notmatch '^https://[A-Za-z0-9._:/-]+$') { Stop-WithMessage 'Public health URL must be an https URL without shell characters.' }
  Save-Config $config
  return $config
}

function Invoke-Ssh([string]$Target, [int]$Port, [string]$Script) {
  $Script | & ssh -p $Port $Target bash -s
  if ($LASTEXITCODE -ne 0) { throw "Remote operation failed with exit code $LASTEXITCODE." }
}

function Quote-Bash([string]$Value) {
  # All values passed here have already passed the strict path/name validators.
  return "'" + $Value + "'"
}

function Invoke-RemoteAction($Config, [ValidateSet('backup', 'rollback', 'status', 'prune')][string]$RemoteAction) {
  $script = @"
set -euo pipefail
export OPENLABSTOCK_APP_DIR=$(Quote-Bash $Config.appDir)
export OPENLABSTOCK_SERVICE_NAME=$(Quote-Bash $Config.serviceName)
export OPENLABSTOCK_DATA_DIR=$(Quote-Bash $Config.dataDir)
export OPENLABSTOCK_ENV_FILE=$(Quote-Bash $Config.envFile)
export OPENLABSTOCK_BACKUP_DIR=$(Quote-Bash $Config.backupDir)
$(if ($Config.publicHealthUrl) { "export OPENLABSTOCK_PUBLIC_HEALTH_URL=$(Quote-Bash $Config.publicHealthUrl)" } else { '' })
if [ $(Quote-Bash $RemoteAction) = 'backup' ] && ! grep -q 'backup_install()' $(Quote-Bash $Config.updateScript) 2>/dev/null; then
  SERVICE_USER="`$(systemctl show -p User --value $(Quote-Bash $Config.serviceName) 2>/dev/null || true)"
  SERVICE_GROUP="`$(systemctl show -p Group --value $(Quote-Bash $Config.serviceName) 2>/dev/null || true)"
  [ -n "`$SERVICE_USER" ] && [ "`$SERVICE_USER" != '-' ] || SERVICE_USER=root
  [ -n "`$SERVICE_GROUP" ] && [ "`$SERVICE_GROUP" != '-' ] || SERVICE_GROUP="`$SERVICE_USER"
  install -d -o "`$SERVICE_USER" -g "`$SERVICE_GROUP" -m 700 $(Quote-Bash $Config.backupDir)
  if [ "`$SERVICE_USER" = root ]; then
    env DATA_DIR=$(Quote-Bash $Config.dataDir) BACKUP_DIR=$(Quote-Bash $Config.backupDir) $(Quote-Bash "$Config.appDir/scripts/backup.mjs")
  else
    runuser -u "`$SERVICE_USER" -- env DATA_DIR=$(Quote-Bash $Config.dataDir) BACKUP_DIR=$(Quote-Bash $Config.backupDir) /usr/bin/node $(Quote-Bash "$Config.appDir/scripts/backup.mjs")
  fi
else
  $(Quote-Bash $Config.updateScript) $(Quote-Bash $RemoteAction)$(if ($RemoteAction -eq 'prune') { ' 30 --yes' } else { '' })
fi
"@
  Write-Host "`nRunning remote action: $RemoteAction" -ForegroundColor Cyan
  Invoke-Ssh $Config.target ([int]$Config.port) $script
}

function Resolve-PnpmCommand {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { return @('pnpm') }
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    Write-Host 'pnpm was not on PATH; using Corepack with the repository-pinned version.' -ForegroundColor Yellow
    return @('corepack', 'pnpm')
  }
  Stop-WithMessage 'pnpm is not installed. Install Node.js, then run: corepack enable pnpm'
}

function Invoke-Pnpm([string[]]$Arguments) {
  $command = Resolve-PnpmCommand
  if ($command.Count -eq 1) {
    & $command[0] @Arguments
  } else {
    & $command[0] $command[1] @Arguments
  }
  if ($LASTEXITCODE -ne 0) { throw "pnpm command failed with exit code $LASTEXITCODE." }
}

function Build-Release {
  $packagePath = Join-Path $repositoryRoot 'package.json'
  $originalPackage = Get-Content -LiteralPath $packagePath -Raw
  try {
    Write-Host "`nSelecting the next release number..." -ForegroundColor Cyan
    Invoke-Pnpm @('run', 'version:next')
    $version = (Get-Content $packagePath -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^(\d{4})\.(\d{1,2})\.(\d{1,2})-r(\d+)$') { throw "Generated package version has an invalid format: $version" }
    $releaseTag = '{0}{1:00}{2:00}-r{3}' -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]
    $manifest = Join-Path $repositoryRoot "OpenLabStock-production-$releaseTag.manifest.txt"
    Write-Host "`nPreparing and validating a release. This may take a few minutes..." -ForegroundColor Cyan
    Invoke-Pnpm @('run', 'release:prepare', '--', '--manifest', $manifest)
    $archive = Join-Path $repositoryRoot "OpenLabStock-production-$releaseTag.tar.gz"
    if (-not (Test-Path -LiteralPath $archive)) {
      $candidate = Get-ChildItem -LiteralPath $repositoryRoot -Filter 'OpenLabStock-production-*.tar.gz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($candidate) { $archive = $candidate.FullName }
    }
    if (-not (Test-Path -LiteralPath $archive)) { throw 'Release command completed but no production archive was found.' }
    return [pscustomobject]@{ Archive = (Resolve-Path -LiteralPath $archive).Path; Manifest = (Resolve-Path -LiteralPath $manifest).Path; Version = $version }
  } catch {
    Set-Content -LiteralPath $packagePath -Value $originalPackage -Encoding UTF8
    throw
  }
}

function Invoke-Update($Config) {
  $archiveInput = Read-Host 'Production archive path (leave empty to build a new release)'
  $manifestInput = ''
  if ([string]::IsNullOrWhiteSpace($archiveInput)) {
    $release = Build-Release
    $archiveInput = $release.Archive
    $manifestInput = $release.Manifest
  } else {
    $archiveInput = (Resolve-Path -LiteralPath $archiveInput.Trim() -ErrorAction Stop).Path
    $manifestInput = Read-Value 'Manifest path' ''
    $manifestInput = (Resolve-Path -LiteralPath $manifestInput -ErrorAction Stop).Path
  }
  $archiveName = Split-Path -Leaf $archiveInput
  $manifestName = Split-Path -Leaf $manifestInput
  if ($archiveName -notmatch '^OpenLabStock-production-\d{8}-r\d+\.tar\.gz$') { Stop-WithMessage 'Archive name must be OpenLabStock-production-YYYYMMDD-rN.tar.gz.' }
  if ($manifestName -notmatch '^OpenLabStock-production-\d{8}-r\d+\.manifest\.txt$') { Stop-WithMessage 'Manifest name must match the archive release name.' }
  $id = [Guid]::NewGuid().ToString('N')
  $remoteDirectory = "/tmp/openlabstock-update-$id"
  Write-Host "`nCreating a protected remote staging directory..." -ForegroundColor Cyan
  Invoke-Ssh $Config.target ([int]$Config.port) "set -euo pipefail; install -d -m 700 $(Quote-Bash $remoteDirectory)"
  try {
    Write-Host 'Uploading the archive and manifest. SSH may ask for the password.' -ForegroundColor Cyan
    & scp -P ([int]$Config.port) -- $archiveInput $manifestInput "$($Config.target):$remoteDirectory/"
    if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE." }
    $script = @"
set -euo pipefail
test "`$(id -u)" -eq 0 || { echo 'The remote update action must run as root.' >&2; exit 1; }
export OPENLABSTOCK_APP_DIR=$(Quote-Bash $Config.appDir)
export OPENLABSTOCK_SERVICE_NAME=$(Quote-Bash $Config.serviceName)
export OPENLABSTOCK_DATA_DIR=$(Quote-Bash $Config.dataDir)
export OPENLABSTOCK_ENV_FILE=$(Quote-Bash $Config.envFile)
export OPENLABSTOCK_BACKUP_DIR=$(Quote-Bash $Config.backupDir)
$(if ($Config.publicHealthUrl) { "export OPENLABSTOCK_PUBLIC_HEALTH_URL=$(Quote-Bash $Config.publicHealthUrl)" } else { '' })
NEXT_UPDATE_SCRIPT=$(Quote-Bash "$remoteDirectory/update-openlabstock.sh")
tar -xOzf $(Quote-Bash "$remoteDirectory/$archiveName") deploy/systemd/update-openlabstock.sh > "`$NEXT_UPDATE_SCRIPT"
chmod 755 "`$NEXT_UPDATE_SCRIPT"
$(Quote-Bash $Config.updateScript) update $(Quote-Bash "$remoteDirectory/$archiveName") --manifest $(Quote-Bash "$remoteDirectory/$manifestName")
$(Quote-Bash $Config.updateScript) status
install -o root -g root -m 755 "`$NEXT_UPDATE_SCRIPT" $(Quote-Bash $Config.updateScript)
echo 'Installed the update/backup helper from the verified release package.'
"@
    Write-Host 'The server will back up SQLite, switch atomically, and verify health.' -ForegroundColor Cyan
    Invoke-Ssh $Config.target ([int]$Config.port) $script
  } finally {
    try { Invoke-Ssh $Config.target ([int]$Config.port) "rm -rf -- $(Quote-Bash $remoteDirectory)" } catch { Write-Host 'Remote staging cleanup did not complete; it is safe to remove later.' -ForegroundColor Yellow }
  }
}

function Show-Menu {
  Write-Host "`nOpenLabStock operations" -ForegroundColor Green
  Write-Host '1. Build and update'
  Write-Host '2. Backup database'
  Write-Host '3. Rollback application'
  Write-Host '4. Show status'
  Write-Host '5. Prune old application directories'
  Write-Host '0. Exit'
  switch (Read-Host 'Choose an action') {
    '1' { return 'update' }
    '2' { return 'backup' }
    '3' { return 'rollback' }
    '4' { return 'status' }
    '5' { return 'prune' }
    default { return 'exit' }
  }
}

try {
  Require-Command 'ssh'
  Require-Command 'scp'
  if ($Action -eq 'menu') { $Action = Show-Menu }
  if ($Action -eq 'exit') { exit 0 }
  $config = Get-RemoteConfig
  switch ($Action) {
    'update' { Invoke-Update $config }
    'backup' { Invoke-RemoteAction $config 'backup' }
    'rollback' {
      if ((Read-Host 'Rollback to the latest previous application directory? Type YES') -ne 'YES') { Stop-WithMessage 'Rollback cancelled.' }
      Invoke-RemoteAction $config 'rollback'
    }
    'status' { Invoke-RemoteAction $config 'status' }
    'prune' {
      if ((Read-Host 'Delete old program directories older than 30 days? Type DELETE') -ne 'DELETE') { Stop-WithMessage 'Prune cancelled.' }
      Invoke-RemoteAction $config 'prune'
    }
  }
  Write-Host "`nOperation completed." -ForegroundColor Green
} catch {
  Stop-WithMessage $_.Exception.Message
}

if ($Host.Name -notmatch 'ServerHost') { Read-Host 'Press Enter to close' | Out-Null }
