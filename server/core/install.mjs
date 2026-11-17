// Bridge install scripts (/api/install, /auth/install, /install) and the device-name check they call.
import { casefold, isPrintable, pyLen, pyStrip } from './py.mjs';

const powershellLiteral = (value) => `'${String(value || '').replace(/'/g, "''")}'`;
const shellLiteral = (value) => `'${String(value || '').replace(/'/g, `'"'"'`)}'`;

const INVALID_INTERNAL_NAME = "Invalid device name. Use 1-32 characters: letters, numbers, '.', '_' or '-', "
  + 'starting with a letter or number.';
const INVALID_DISPLAY_NAME = 'Invalid device name. Use 1-32 visible characters with no line breaks.';
const DUPLICATE_DEVICE_NAME = 'That device name is already in use. Choose another.';
const DEVICE_NAME_CHECK_FAILED = 'Could not validate device name. Check your connection and try again.';

export function checkDeviceName(items, name, mode, current = '') {
  name = pyStrip(String(name || ''));
  if (mode === 'identity') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) return ['', INVALID_INTERNAL_NAME];
  } else if (mode === 'display') {
    if (!(pyLen(name) >= 1 && pyLen(name) <= 32) || !isPrintable(name)) return ['', INVALID_DISPLAY_NAME];
  } else {
    return ['', 'Invalid validation mode.'];
  }
  const candidate = casefold(name);
  current = casefold(String(current || ''));
  for (const item of items) {
    const identity = String(item.deviceName ?? '');
    if (current && casefold(identity) === current) continue;
    const display = String(item.deviceDisplayName || identity);
    const values = mode === 'identity' ? [identity, display] : [display];
    if (values.some((value) => casefold(pyStrip(value)) === candidate)) return ['', DUPLICATE_DEVICE_NAME];
  }
  return [name, ''];
}

function unixDeviceNameBlock(server, apiKey, name) {
  return `# Preserve the original deviceName as the stable identity; only the display name changes.
REQUESTED_NAME=${shellLiteral(name)}
EXISTING_NAME=""
EXISTING_DISPLAY_NAME=""
if [ -f "$DIR/config.json" ]; then
  EXISTING_NAME=$(python3 -c "import json; print(json.load(open('$DIR/config.json')).get('deviceName',''))" 2>/dev/null || true)
  EXISTING_DISPLAY_NAME=$(python3 -c "import json; print(json.load(open('$DIR/config.json')).get('deviceDisplayName',''))" 2>/dev/null || true)
fi
VALIDATION_URL=${shellLiteral(`${server}/api/bridge/device-name/validate`)}
VALIDATION_KEY=${shellLiteral(apiKey)}
validate_name() {
  # Without a credential (public install) there is no account yet; approval checks the name instead.
  [ -z "$VALIDATION_KEY" ] && { printf '%s' "$1"; return 0; }
  VALIDATION_URL="$VALIDATION_URL" VALIDATION_KEY="$VALIDATION_KEY" node -e '
    const [name, mode, current] = process.argv.slice(1);
    const url = new URL(process.env.VALIDATION_URL);
    url.searchParams.set("name", name);
    url.searchParams.set("mode", mode);
    if (current) url.searchParams.set("current", current);
    fetch(url, {headers: {"x-api-key": process.env.VALIDATION_KEY}})
      .then(async response => {
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!result.ok) { console.error(result.error); process.exitCode = 1; return; }
        process.stdout.write(result.name);
      })
      .catch(() => { console.error("${DEVICE_NAME_CHECK_FAILED}"); process.exitCode = 2; });
  ' -- "$1" "$2" "$3"
}
if [ -n "$EXISTING_NAME" ]; then
  NAME="$EXISTING_NAME"
  DEFAULT_NAME="\${EXISTING_DISPLAY_NAME:-$EXISTING_NAME}"
  if tty -s 2>/dev/null < /dev/tty; then
    while true; do
      printf "Device name [%s]: " "$DEFAULT_NAME" > /dev/tty
      read -r ENTERED_NAME < /dev/tty
      if DEVICE_DISPLAY_NAME=$(validate_name "\${ENTERED_NAME:-$DEFAULT_NAME}" display "$NAME"); then
        break
      else
        [ $? -eq 2 ] && exit 1
      fi
    done
  else
    DEVICE_DISPLAY_NAME="$DEFAULT_NAME"
  fi
else
  DEFAULT_NAME="\${REQUESTED_NAME:-$(hostname)}"
  if tty -s 2>/dev/null < /dev/tty; then
    while true; do
      printf "Device name [%s]: " "$DEFAULT_NAME" > /dev/tty
      read -r ENTERED_NAME < /dev/tty
      if NAME=$(validate_name "\${ENTERED_NAME:-$DEFAULT_NAME}" identity ""); then
        break
      else
        [ $? -eq 2 ] && exit 1
      fi
    done
  else
    NAME=$(validate_name "$DEFAULT_NAME" identity "") || exit 1
  fi
  DEVICE_DISPLAY_NAME="$NAME"
fi`;
}

function windowsInstallScript(url, server, apiKey, name) {
  const pkg = powershellLiteral(url);
  const serverValue = powershellLiteral(server);
  const keyValue = powershellLiteral(apiKey);
  const nameValue = powershellLiteral(name);
  const validationUri = powershellLiteral(`${server}/api/bridge/device-name/validate`);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$isSystemContext = $currentIdentity -match '(^|\\\\)SYSTEM$'",
    "$isAdministrator = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)",
    "if (-not $isSystemContext -and -not $isAdministrator) {",
    "  Write-Host 'ERROR: Administrator privileges are required to install Baton Bridge on Windows.' -ForegroundColor Red",
    "  Write-Host 'Open PowerShell using \"Run as administrator\", then run the install command again.' -ForegroundColor Yellow",
    "  return",
    "}",
    "$task = Get-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
    "$useSystemTask = $isSystemContext -or ($currentIdentity -match '(^|\\\\)ssm-user$')",
    "$targetHome = $HOME",
    "if ($useSystemTask) {",
    "  $profiles = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { -not $_.Special -and $_.LocalPath -and (Test-Path $_.LocalPath) }",
    "  $targetProfile = $profiles | Where-Object {",
    "    (Test-Path (Join-Path $_.LocalPath '.claude')) -or (Test-Path (Join-Path $_.LocalPath '.codex'))",
    "  } | Sort-Object LastUseTime -Descending | Select-Object -First 1",
    "  if (-not $targetProfile) {",
    "    $targetProfile = $profiles | Where-Object { $_.LocalPath -notmatch '\\\\(Public|Default|defaultuser0|ssm-user)$' } | Sort-Object LastUseTime -Descending | Select-Object -First 1",
    "  }",
    "  if ($targetProfile) { $targetHome = $targetProfile.LocalPath }",
    "}",
    "$node = Get-Command node.exe -ErrorAction SilentlyContinue",
    "if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }",
    "$nodeCandidates = @($node.Source)",
    "if ($task) {",
    "  $nodeCandidates += $task.Actions | ForEach-Object { $_.Execute } | Where-Object { $_ -and ([IO.Path]::GetFileName($_) -ieq 'node.exe') }",
    "}",
    "$nodeCandidates += @(",
    "  (Join-Path $env:ProgramFiles 'nodejs\\node.exe'),",
    "  (Join-Path $targetHome 'AppData\\Local\\Programs\\nodejs\\node.exe')",
    ")",
    "foreach ($root in @(",
    "  'C:\\nodejs',",
    "  (Join-Path $targetHome 'AppData\\Roaming\\nvm'),",
    "  (Join-Path $targetHome 'AppData\\Local\\fnm'),",
    "  (Join-Path $targetHome 'AppData\\Local\\Volta\\tools\\image\\node')",
    ")) {",
    "  if (-not $root -or -not (Test-Path $root)) { continue }",
    "  $nodeCandidates += Get-ChildItem $root -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }",
    "}",
    "$nodePath = ''",
    "$nodeVersion = $null",
    "$nodeErrors = @()",
    "foreach ($candidate in $nodeCandidates | Select-Object -Unique) {",
    "  if (-not $candidate -or -not (Test-Path $candidate)) { continue }",
    "  try {",
    "    $candidateVersion = [version](& $candidate -p \"process.versions.node\" 2>&1)",
    "    if ($candidateVersion -ge [version]'22.15.0') {",
    "      $nodePath = $candidate",
    "      $nodeVersion = $candidateVersion",
    "      break",
    "    }",
    "    $nodeErrors += \"${candidate}: version $candidateVersion is below 22.15.0\"",
    "  } catch {",
    "    $nodeErrors += \"${candidate}: $($_.Exception.Message)\"",
    "  }",
    "}",
    "if (-not $nodePath) {",
    "  $checked = ($nodeCandidates | Select-Object -Unique) -join ', '",
    "  $details = $nodeErrors -join '; '",
    "  throw \"Node.js 22.15+ was not found or could not run. Checked: $checked. Details: $details. Install Node.js 22.15+ from https://nodejs.org/ and retry.\"",
    "}",
    "$env:Path = (Split-Path $nodePath) + ';' + $env:Path",
    "$dir = Join-Path $targetHome '.baton-bridge'",
    "$configPath = Join-Path $dir 'config.json'",
    "$existingName = ''",
    "$existingDisplayName = ''",
    "$existingConfig = $null",
    "if (Test-Path $configPath) {",
    "  try {",
    "    $existingConfig = Get-Content $configPath -Raw | ConvertFrom-Json",
    "    $existingName = [string]$existingConfig.deviceName",
    "    $existingDisplayName = [string]$existingConfig.deviceDisplayName",
    "  } catch {}",
    "}",
    "$requestedName = " + nameValue,
    "$validationUri = " + validationUri,
    "$headers = @{ 'x-api-key' = " + keyValue + " }",
    "function Test-DeviceName([string]$candidate, [string]$mode, [string]$current = '') {",
    "  $uri = $validationUri + '?name=' + [uri]::EscapeDataString($candidate) + '&mode=' + $mode",
    "  if ($current) { $uri += '&current=' + [uri]::EscapeDataString($current) }",
    "  if (-not $headers['x-api-key']) { return @{ ok = $true; name = $candidate } }",
    "  try { return Invoke-RestMethod -UseBasicParsing -Uri $uri -Headers $headers } catch {",
    "    throw " + powershellLiteral(DEVICE_NAME_CHECK_FAILED),
    "  }",
    "}",
    "if ([string]::IsNullOrWhiteSpace($existingName)) {",
    "  $defaultName = if ([string]::IsNullOrWhiteSpace($requestedName)) { $env:COMPUTERNAME } else { $requestedName }",
    "  while ($true) {",
    "    if ($isSystemContext) { $candidate = $defaultName } else {",
    "      $enteredName = Read-Host \"Device name [$defaultName]\"",
    "      $candidate = if ([string]::IsNullOrWhiteSpace($enteredName)) { $defaultName } else { $enteredName }",
    "    }",
    "    $result = Test-DeviceName $candidate 'identity'",
    "    if ($result.ok) { $deviceName = [string]$result.name; break }",
    "    if ($isSystemContext) { throw $result.error }",
    "    Write-Host $result.error",
    "  }",
    "  $deviceDisplayName = $deviceName",
    "} else {",
    "  $deviceName = $existingName",
    "  $defaultName = if ([string]::IsNullOrWhiteSpace($existingDisplayName)) { $existingName } else { $existingDisplayName }",
    "  if ($isSystemContext) {",
    "    $deviceDisplayName = $defaultName",
    "  } else {",
    "    while ($true) {",
    "      $enteredName = Read-Host \"Device name [$defaultName]\"",
    "      $candidate = if ([string]::IsNullOrWhiteSpace($enteredName)) { $defaultName } else { $enteredName }",
    "      $result = Test-DeviceName $candidate 'display' $deviceName",
    "      if ($result.ok) { $deviceDisplayName = [string]$result.name; break }",
    "      Write-Host $result.error",
    "    }",
    "  }",
    "}",
    "if ($task) { Stop-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue }",
    "$legacy = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -match '(?i)\\\\\\.baton-bridge\\\\.*bridge(-launcher)?\\.mjs' }",
    "$legacy | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "if ($legacy) { Start-Sleep -Milliseconds 500 }",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$archive = Join-Path $env:TEMP 'baton-bridge.tar.gz'",
    "Invoke-WebRequest -UseBasicParsing -Uri " + pkg + " -OutFile $archive",
    "$tar = Get-Command tar.exe -ErrorAction SilentlyContinue",
    "if (-not $tar) { throw 'tar.exe is required.' }",
    "& $tar.Source -xzf $archive -C $dir",
    "if ($LASTEXITCODE -ne 0) { throw 'Bridge package extraction failed.' }",
    "Remove-Item $archive -Force -ErrorAction SilentlyContinue",
    "$npm = Join-Path (Split-Path $nodePath) 'npm.cmd'",
    "if (-not (Test-Path $npm)) {",
    "  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue",
    "  if (-not $npmCommand) { throw 'npm is required.' }",
    "  $npm = $npmCommand.Source",
    "}",
    "Push-Location $dir",
    "try {",
    "  $npmExit = 1",
    "  foreach ($attempt in 1..2) {",
    "    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }",
    "    & $npm ci --omit=dev --include=optional --silent --no-audit --no-fund",
    "    $npmExit = $LASTEXITCODE",
    "    if ($npmExit -eq 0) { & $nodePath (Join-Path $dir 'verify-dependencies.mjs'); $npmExit = $LASTEXITCODE }",
    "    if ($npmExit -eq 0) { break }",
    "  }",
    "} finally { Pop-Location }",
    "if ($npmExit -ne 0) { throw 'Bridge dependency installation failed.' }",
    "$config = @{ server = " + serverValue + "; apiKey = " + keyValue + "; deviceName = $deviceName; deviceDisplayName = $deviceDisplayName }",
    "if ($existingConfig.bridgeId) { $config.bridgeId = [string]$existingConfig.bridgeId }",
    // A public install keeps an earlier pairing; otherwise the computer joins an account first.
    "if (-not $config.apiKey) { foreach ($k in 'apiKey', 'accountKey', 'accountKeyAt', 'accounts') { if ($existingConfig.$k) { $config[$k] = $existingConfig.$k } } }",
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)",
    "if (-not $config.apiKey) { & $nodePath (Join-Path $dir 'bridge.mjs') pair; if ($LASTEXITCODE -ne 0) { throw 'This computer has not joined an account.' } }",
    "$bridge = Join-Path $dir 'bridge-launcher.mjs'",
    "$logPath = Join-Path $dir 'bridge.log'",
    "Remove-Item $logPath -Force -ErrorAction SilentlyContinue",
    "$wrapper = Join-Path $dir 'run-bridge.cmd'",
    "$wrapperLines = @(",
    "  '@echo off',",
    "  ('set \"USERPROFILE=' + $targetHome + '\"'),",
    "  ('set \"HOME=' + $targetHome + '\"'),",
    "  ('set \"PATH=' + (Split-Path $nodePath) + ';%PATH%\"'),",
    "  ('\"' + $nodePath + '\" \"' + $bridge + '\" >> \"' + $logPath + '\" 2>&1')",
    ")",
    "[System.IO.File]::WriteAllLines($wrapper, $wrapperLines, [System.Text.Encoding]::ASCII)",
    "$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/d /c \"' + $wrapper + '\"') -WorkingDirectory $dir",
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)",
    "if ($useSystemTask) {",
    "  $trigger = New-ScheduledTaskTrigger -AtStartup",
    "  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "} else {",
    "  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity",
    "  $principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType S4U -RunLevel Highest",
    "}",
    "function Wait-BatonBridge {",
    "  $runningChecks = 0",
    "  foreach ($attempt in 1..10) {",
    "    $currentTask = Get-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
    "    if ($currentTask -and $currentTask.State -eq 'Running') {",
    "      $runningChecks++",
    "      if ($runningChecks -ge 4) { return $true }",
    "    } else {",
    "      $runningChecks = 0",
    "    }",
    "    Start-Sleep -Seconds 1",
    "  }",
    "  return $false",
    "}",
    "function Start-BatonTask($taskPrincipal) {",
    "  Register-ScheduledTask -TaskName 'Baton Bridge' -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null",
    "  Start-ScheduledTask -TaskName 'Baton Bridge'",
    "  return (Wait-BatonBridge)",
    "}",
    "$taskStarted = $false",
    "$taskError = ''",
    "try {",
    "  $taskStarted = Start-BatonTask $principal",
    "} catch {",
    "  $taskError = $_.Exception.Message",
    "}",
    "if (-not $taskStarted -and -not $useSystemTask -and -not (Test-Path $logPath)) {",
    "  Write-Host 'Baton Bridge did not start with S4U; retrying with the current logged-on user...' -ForegroundColor Yellow",
    "  Stop-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
    "  $principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Highest",
    "  $taskError = ''",
    "  try {",
    "    $taskStarted = Start-BatonTask $principal",
    "  } catch {",
    "    $taskError = $_.Exception.Message",
    "  }",
    "}",
    "if (-not $taskStarted) {",
    "  $failedTask = Get-ScheduledTask -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
    "  $taskInfo = Get-ScheduledTaskInfo -TaskName 'Baton Bridge' -ErrorAction SilentlyContinue",
    "  $taskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }",
    "  $taskResultText = if ($null -ne $taskResult) { \"$taskResult / $('0x{0:X8}' -f ([uint32]$taskResult))\" } else { 'unavailable' }",
    "  $taskState = if ($failedTask) { [string]$failedTask.State } else { 'NotFound' }",
    "  $taskHint = if ($null -ne $taskResult -and [uint32]$taskResult -eq 0x00041303) { 'The task action has not run.' } else { 'The Bridge did not remain running for 3 seconds.' }",
    "  $logTail = if (Test-Path $logPath) { (Get-Content $logPath -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine } else { 'No bridge log was created.' }",
    "  $taskEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction SilentlyContinue |",
    "    Where-Object { $_.Message -like '*Baton Bridge*' } | Select-Object -First 4 | ForEach-Object {",
    "      'Event ' + $_.Id + ': ' + (($_.Message -replace '\\s+', ' ').Trim())",
    "    })",
    "  $eventSummary = if ($taskEvents.Count -gt 0) { $taskEvents -join [Environment]::NewLine } else { 'No Task Scheduler operational event was available.' }",
    "  throw \"Baton Bridge failed to start within 10 seconds. $taskHint`nTask state: $taskState`nTask result: $taskResultText`nStart error: $taskError`nTask Scheduler: $eventSummary`nLog ($logPath):`n$logTail\"",
    "}",
    "Write-Output \"Baton Bridge installed and running for $deviceName.\"",
    "Write-Output \"  Node:    $nodePath ($nodeVersion)\"",
    "Write-Output \"  Profile: $targetHome\"",
    "Write-Output \"  Logs:    $logPath\"",
    "",  ].join('\n');
}

// `presign()` is the Bridge package's download URL; `null` when the server has no package bucket.
export async function installScript({ headers }, apiKey, name, platform, presign) {
  const url = await presign();
  if (url === null) return { error: 'bucket not configured' };
  // Use x-forwarded headers from API GW if available; the scheme as uvicorn's proxy headers set it.
  const forwarded = headers.get('x-forwarded-proto');
  const scheme = ['http', 'https', 'ws', 'wss'].includes(pyStrip(forwarded ?? '')) ? pyStrip(forwarded) : 'http';
  const proto = forwarded ?? scheme;
  const host = headers.get('host') ?? '';
  const server = host ? `${proto}://${host}/v1` : `${scheme}:///v1`;
  if (platform.toLowerCase() === 'windows') return { text: windowsInstallScript(url, server, apiKey, name) };
  const nameBlock = unixDeviceNameBlock(server, apiKey, name);
  const script = (
    '#!/bin/bash\n' +
    'set -e\n' +
    '\n' +
    '# Require Node.js >= 22.15\n' +
    'if ! command -v node &>/dev/null; then\n' +
    '  echo "\\033[0;31mError: Node.js is not installed.\\033[0m" >&2\n' +
    '  echo "Install Node.js 22.15+ from https://nodejs.org/ and try again." >&2\n' +
    '  exit 1\n' +
    'fi\n' +
    'NODE_VER=$(node -p "process.versions.node")\n' +
    'if ! node -e "const [major, minor] = process.versions.node.split(\'.\').map(Number); process.exit(major > 22 || (major === 22 && minor >= 15) ? 0 : 1)"; then\n' +
    '  echo "\\033[0;31mError: Node.js $NODE_VER is too old. Requires >= 22.15.\\033[0m" >&2\n' +
    '  echo "Current: $(node --version)  —  upgrade from https://nodejs.org/" >&2\n' +
    '  exit 1\n' +
    'fi\n' +
    '\n' +
    'DIR="$HOME/.baton-bridge"\n' +
    nameBlock + '\n' +
    'NODE=$(which node)\n' +
    'NODE_DIR=$(dirname "$NODE")\n' +
    'mkdir -p "$DIR" && cd "$DIR"\n' +
    'curl -sL "' + url + '" | tar xz 2>/dev/null\n' +
    'install_bridge_dependencies() {\n' +
    '  npm ci --omit=dev --include=optional --silent --no-audit --no-fund 2>/dev/null &&\n' +
    '    node verify-dependencies.mjs\n' +
    '}\n' +
    'install_bridge_dependencies || { sleep 2; install_bridge_dependencies; }\n' +
    'BATON_SERVER=' + shellLiteral(server) + ' BATON_API_KEY=' + shellLiteral(apiKey) + ' ' +
    'BATON_DEVICE_NAME="$NAME" BATON_DEVICE_DISPLAY_NAME="$DEVICE_DISPLAY_NAME" ' +
    'node -e \'const fs=require("fs");const p=process.argv[1];' +
    'let existing={};try{existing=JSON.parse(fs.readFileSync(p,"utf8"));}catch{}' +
    'const config={server:process.env.BATON_SERVER,apiKey:process.env.BATON_API_KEY,' +
    'deviceName:process.env.BATON_DEVICE_NAME,deviceDisplayName:process.env.BATON_DEVICE_DISPLAY_NAME};' +
    'if(existing.bridgeId)config.bridgeId=existing.bridgeId;' +
    'if(!config.apiKey)for(const k of ["apiKey","accountKey","accountKeyAt","accounts"])if(existing[k])config[k]=existing[k];' +
    'fs.writeFileSync(p,JSON.stringify(config,null,2),{mode:0o600});fs.chmodSync(p,0o600);\' "$DIR/config.json"\n' +
    // A public install has no credential: the computer joins an account (QR code) before its service starts.
    'node -e \'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).apiKey?0:1)\' "$DIR/config.json" ||\n' +
    '  node "$DIR/bridge.mjs" pair\n' +
    '\n' +
    '# WSL: symlink Windows .claude directory so bridge can monitor Windows CC sessions\n' +
    'if [ -n "$WSL_DISTRO_NAME" ]; then\n' +
    '  WIN_USER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d "\\r\\n")\n' +
    '  if [ -n "$WIN_USER" ]; then\n' +
    '    WIN_CLAUDE="/mnt/c/Users/${WIN_USER}/.claude"\n' +
    '    if [ -d "$WIN_CLAUDE" ] && [ ! -e "$HOME/.claude" ]; then\n' +
    '      ln -sf "$WIN_CLAUDE" "$HOME/.claude"\n' +
    '      printf "  Linked Windows .claude → %s\\n" "$WIN_CLAUDE"\n' +
    '    elif [ -d "$WIN_CLAUDE" ] && [ -L "$HOME/.claude" ]; then\n' +
    '      printf "  Symlink already exists: %s\\n" "$(readlink $HOME/.claude)"\n' +
    '    fi\n' +
    '  fi\n' +
    'fi\n' +
    '\n' +
    '# Setup auto-start service\n' +
    'if [ "$(uname)" = "Darwin" ]; then\n' +
    '  # macOS: launchd\n' +
    '  PLIST="$HOME/Library/LaunchAgents/com.baton.bridge.plist"\n' +
    '  mkdir -p "$HOME/Library/LaunchAgents"\n' +
    '  cat > "$PLIST" << PLIST_EOF\n' +
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    '  <key>Label</key><string>com.baton.bridge</string>\n' +
    '  <key>ProgramArguments</key><array>\n' +
    '    <string>$NODE</string>\n' +
    '    <string>$DIR/bridge.mjs</string>\n' +
    '  </array>\n' +
    '  <key>EnvironmentVariables</key>\n' +
    '  <dict>\n' +
    '    <key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n' +
    '  </dict>\n' +
    '  <key>RunAtLoad</key><true/>\n' +
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n' +
    '  <key>StandardOutPath</key><string>$DIR/bridge.log</string>\n' +
    '  <key>StandardErrorPath</key><string>$DIR/bridge.log</string>\n' +
    '</dict></plist>\n' +
    'PLIST_EOF\n' +
    '  launchctl unload "$PLIST" 2>/dev/null || true\n' +
    '  launchctl load "$PLIST"\n' +
    '  echo ""\n' +
    '  echo "================================================================"\n' +
    '  printf "  \\033[0;32mBridge installed and running successfully! (launchd)\\033[0m\\n"\n' +
    '  echo "  Device: $NAME"\n' +
    '  echo "  Logs:   $DIR/bridge.log"\n' +
    '  echo "================================================================"\n' +
    '  echo ""\n' +
    '  echo "  Stop:    launchctl unload $PLIST"\n' +
    '  echo "  Start:   launchctl load $PLIST"\n' +
    '  echo "  Logs:    tail -f $DIR/bridge.log"\n' +
    'else\n' +
    '  # Linux: systemd\n' +
    '  SERVICE_DIR="$HOME/.config/systemd/user"\n' +
    '  mkdir -p "$SERVICE_DIR"\n' +
    '  cat > "$SERVICE_DIR/baton-bridge.service" << SVC_EOF\n' +
    '[Unit]\n' +
    'Description=Baton Bridge\n' +
    'After=network.target\n' +
    '[Service]\n' +
    'ExecStart=$NODE $DIR/bridge.mjs\n' +
    'Restart=on-failure\n' +
    'RestartSec=5\n' +
    'KillMode=process\n' +
    '[Install]\n' +
    'WantedBy=default.target\n' +
    'SVC_EOF\n' +
    '  sudo loginctl enable-linger $(whoami) 2>/dev/null || loginctl enable-linger $(whoami) 2>/dev/null || true\n' +
    '  export XDG_RUNTIME_DIR=/run/user/$(id -u)\n' +
    '  systemctl --user daemon-reload\n' +
    '  systemctl --user enable baton-bridge\n' +
    '  systemctl --user restart baton-bridge\n' +
    '  echo ""\n' +
    '  echo "================================================================"\n' +
    '  printf "  \\033[0;32mBridge installed and running successfully! (systemd)\\033[0m\\n"\n' +
    '  echo "  Device: $NAME"\n' +
    '  echo "================================================================"\n' +
    '  echo ""\n' +
    '  echo "  Stop:    systemctl --user stop baton-bridge"\n' +
    '  echo "  Start:   systemctl --user start baton-bridge"\n' +
    '  echo "  Logs:    journalctl --user -u baton-bridge -f"\n' +
    'fi\n'  );
  return { text: script };
}
