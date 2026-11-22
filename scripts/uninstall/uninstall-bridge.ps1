param(
  [switch]$DryRun,
  [string]$UserHome = [Environment]::GetFolderPath('UserProfile')
)

$ErrorActionPreference = 'Stop'
$taskNames = @(
  'Baton Bridge',
  'Baton Presence',
  'AgentPeek Bridge',
  'AgentPeek Bridge Service',
  'Claude Bridge'
)
$serviceNames = @(
  'BatonBridge',
  'baton-bridge',
  'AgentPeekBridge',
  'agentpeek-bridge',
  'ClaudeBridge',
  'claude-bridge'
)
$bridgeDirs = @(
  (Join-Path $UserHome '.baton-bridge'),
  (Join-Path $UserHome '.agentpeek-bridge'),
  (Join-Path $UserHome '.claude-bridge')
)
# The Pi status extension the Bridge installs (bridge/pi-runtime.mjs).
$piAgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $UserHome '.pi\agent' }
$piExtension = Join-Path $piAgentDir 'extensions\baton-bridge-status.js'

function Invoke-Step {
  param(
    [scriptblock]$Action,
    [string]$Description
  )
  Write-Output "+ $Description"
  if (-not $DryRun) {
    & $Action
  }
}

foreach ($taskName in $taskNames) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Invoke-Step {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    } "Remove scheduled task '$taskName'"
  }
}

foreach ($serviceName in $serviceNames) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) {
    Invoke-Step {
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
      & sc.exe delete $serviceName | Out-Null
    } "Remove Windows service '$serviceName'"
  }
}

$bridgeProcesses = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('node.exe', 'node', 'cmd.exe') -and
  $_.CommandLine -match '(?i)\\\.(baton|agentpeek|claude)-bridge\\' -and
  $_.CommandLine -match '(?i)(bridge|bridge-launcher)\.mjs|bridge-service\.cmd'
}
foreach ($process in $bridgeProcesses) {
  Invoke-Step {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  } "Stop Bridge process $($process.ProcessId)"
}

foreach ($dir in $bridgeDirs) {
  if (Test-Path -LiteralPath $dir) {
    Invoke-Step {
      Remove-Item -LiteralPath $dir -Recurse -Force
    } "Remove '$dir'"
  }
}

if (Test-Path -LiteralPath $piExtension) {
  Invoke-Step {
    Remove-Item -LiteralPath $piExtension -Force
  } "Remove '$piExtension'"
}

if ($DryRun) {
  Write-Output 'Dry run: nothing was removed.'
} else {
  Write-Output 'Baton/AgentPeek Bridge has been removed.'
}
