// Bridge install scripts (/api/install, /auth/install, /install) and the device-name check they call.
import { isPrintable, length } from './util.mjs';

// Node.js release the installers download into ~/.baton-bridge/node/<version>/ and pin the service to.
export const NODE_VERSION = 'v24.22.3';

const powershellLiteral = (value) => `'${String(value || '').replace(/'/g, "''")}'`;
const shellLiteral = (value) => `'${String(value || '').replace(/'/g, `'"'"'`)}'`;

const INVALID_INTERNAL_NAME = "Invalid device name. Use 1-32 characters: letters, numbers, '.', '_' or '-', "
  + 'starting with a letter or number.';
const INVALID_DISPLAY_NAME = 'Invalid device name. Use 1-32 visible characters with no line breaks.';
const DUPLICATE_DEVICE_NAME = 'That device name is already in use. Choose another.';
const DEVICE_NAME_CHECK_FAILED = 'Could not validate device name. Check your connection and try again.';

export function checkDeviceName(items, name, mode, current = '') {
  name = String(name || '').trim();
  if (mode === 'identity') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) return ['', INVALID_INTERNAL_NAME];
  } else if (mode === 'display') {
    if (!(length(name) >= 1 && length(name) <= 32) || !isPrintable(name)) return ['', INVALID_DISPLAY_NAME];
  } else {
    return ['', 'Invalid validation mode.'];
  }
  const candidate = name.toLowerCase();
  current = String(current || '').toLowerCase();
  for (const item of items) {
    const identity = String(item.deviceName ?? '');
    if (current && identity.toLowerCase() === current) continue;
    const display = String(item.deviceDisplayName || identity);
    const values = mode === 'identity' ? [identity, display] : [display];
    if (values.some((value) => value.trim().toLowerCase() === candidate)) return ['', DUPLICATE_DEVICE_NAME];
  }
  return [name, ''];
}

// SHA-256 of the official archives the installers use (after changing NODE_VERSION, `node scripts/node-checksums.mjs` prints this).
export const NODE_SHA256 = {
  'darwin-arm64.tar.xz': '1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5',
  'darwin-x64.tar.xz': '4daeec962855c1a6e66cda398a25037319dc1bbd4a0939188b3547afbbfb6490',
  'linux-arm64.tar.gz': '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
  'linux-arm64.tar.xz': '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c',
  'linux-x64.tar.gz': '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
  'linux-x64.tar.xz': '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb',
  'win-arm64.zip': 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
  'win-x64.zip': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
};
const NODE_SOURCES = ['https://nodejs.org/dist', 'https://cdn.npmmirror.com/binaries/node'];
const unixNodeSums = Object.entries(NODE_SHA256).filter(([file]) => !file.startsWith('win'))
  .map(([file, sum]) => `    ${file}) want=${sum} ;;`).join('\n');

// Downloads from both sources at once; the first verified archive wins and the other download is
// stopped. On any failure the user's Node.js is used. The installer's PATH gets it (node/npm below);
// the service PATH keeps the user's Node after it (the Bridge puts its own node first for harnesses).
const unixPrivateNode = `install_private_node() {
  local os arch ext file want tmp ok pids="" i=0 src status p
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) return 1 ;; esac
  [ -x "$DIR/node/${NODE_VERSION}/bin/node" ] && return 0
  { [ $os = darwin ] || command -v xz >/dev/null; } && ext=tar.xz || ext=tar.gz
  case "$os-$arch.$ext" in
${unixNodeSums}
    *) return 1 ;;
  esac
  file="node-${NODE_VERSION}-$os-$arch.$ext"
  echo "Installing Node.js ${NODE_VERSION} for Baton Bridge..."
  rm -rf "$DIR"/node/.tmp.*
  mkdir -p "$DIR/node" && tmp=$(mktemp -d "$DIR/node/.tmp.XXXXXX") || return 1
  # bash 3.2's kill fails as a whole when one pid is gone, so each download is checked on its own.
  running() { for p in $pids; do kill -0 $p 2>/dev/null && return 0; done; return 1; }
  stop_downloads() { for p in $pids; do kill $p 2>/dev/null || :; done; wait; }
  trap 'stop_downloads; rm -rf "$tmp"; exit 130' INT TERM HUP
  for src in ${NODE_SOURCES.join(' ')}; do
    i=$((i + 1))
    ( trap 'kill $c 2>/dev/null; exit 1' TERM
      curl -fsL --retry 2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o "$tmp/$i" "$src/${NODE_VERSION}/$file" & c=$!
      wait $c && [ "$( (sha256sum "$tmp/$i" 2>/dev/null || shasum -a 256 "$tmp/$i") | cut -d' ' -f1)" = "$want" ] &&
        mv "$tmp/$i" "$tmp/$i.ok" ) &
    pids="$pids $!"
  done
  while [ ! -e "$tmp/1.ok" ] && [ ! -e "$tmp/2.ok" ] && running; do sleep 0.2; done
  stop_downloads
  ok=$(ls "$tmp"/*.ok 2>/dev/null | head -n 1)
  [ -n "$ok" ] && tar --no-same-owner -xf "$ok" -C "$tmp" && "$tmp/\${file%.tar.*}/bin/node" --version >/dev/null &&
    rm -rf "$DIR/node/${NODE_VERSION}" && mv "$tmp/\${file%.tar.*}" "$DIR/node/${NODE_VERSION}"
  status=$?
  rm -rf "$tmp"
  trap - INT TERM HUP
  [ $status -eq 0 ] || echo "Warning: could not download and verify Node.js ${NODE_VERSION} from nodejs.org or npmmirror.com; using the system Node.js." >&2
  return $status
}
# Once the service runs the new version, earlier private runtimes go.
prune_private_node() { find "$DIR/node" -mindepth 1 -maxdepth 1 ! -name ${NODE_VERSION} -exec rm -rf {} + 2>/dev/null || true; }
install_private_node && export PATH="$DIR/node/${NODE_VERSION}/bin:$PATH"`;

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
  # The short host name: EC2's FQDN (ip-…compute.internal) is longer than the 32-character limit.
  DEFAULT_NAME="\${REQUESTED_NAME:-$( (hostname -s || hostname) 2>/dev/null | cut -c1-32)}"
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
    // Same private runtime as on Unix: the first candidate below, with the user's Node.js as the fallback.
    "function Install-BatonNode {",
    "  $version = '" + NODE_VERSION + "'",
    "  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }",
    "  $name = \"node-$version-win-$arch\"",
    "  $root = Join-Path $targetHome '.baton-bridge\\node'",
    "  $exe = Join-Path $root \"$version\\node.exe\"",
    "  if (Test-Path $exe) { return $exe }",
    "  $sha = @{ " + Object.entries(NODE_SHA256).filter(([file]) => file.startsWith('win')).map(([file, sum]) => `'${file}' = '${sum}'`).join('; ') + " }[\"win-$arch.zip\"]",
    "  $tmp = Join-Path $root ('.tmp.' + [guid]::NewGuid().ToString('N'))",
    "  $jobs = @()",
    "  try {",
    "    Write-Host \"Installing Node.js $version for Baton Bridge...\"",
    "    New-Item -ItemType Directory -Force -Path $tmp | Out-Null",
    "    $jobs = @(foreach ($source in " + NODE_SOURCES.map(powershellLiteral).join(', ') + ") {",
    "      Start-Job -ArgumentList \"$source/$version/$name.zip\", (Join-Path $tmp ([guid]::NewGuid().ToString('N'))), $sha -ScriptBlock {",
    "        param($uri, $file, $sha)",
    "        $ProgressPreference = 'SilentlyContinue'",
    "        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
    "        Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 -Uri $uri -OutFile $file",
    "        if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $sha) { throw \"SHA-256 mismatch: $uri\" }",
    "        $file",
    "      }",
    "    })",
    "    $zip = $null",
    "    $pending = $jobs",
    "    while (-not $zip -and $pending) {",
    "      $done = Wait-Job -Job $pending -Any",
    "      $zip = Receive-Job $done -ErrorAction SilentlyContinue",
    "      $pending = @($pending | Where-Object { $_ -ne $done })",
    "    }",
    "    $jobs | Stop-Job",
    "    if (-not $zip) { throw 'download or checksum failed from both sources' }",
    "    tar.exe -xf $zip -C $tmp",
    "    if ($LASTEXITCODE -eq 0) { & (Join-Path $tmp \"$name\\node.exe\") --version | Out-Null }",
    "    if ($LASTEXITCODE -ne 0) { throw 'the extracted node.exe did not run' }",
    // Antivirus may still hold the new files open.
    "    foreach ($attempt in 1..5) { try { if (Test-Path (Split-Path $exe)) { Remove-Item (Split-Path $exe) -Recurse -Force }; Move-Item (Join-Path $tmp $name) (Split-Path $exe); break } catch { if ($attempt -eq 5) { throw } Start-Sleep -Seconds 1 } }",
    "    return $exe",
    "  } catch {",
    "    Write-Host \"Warning: could not download and verify Node.js $version from nodejs.org or npmmirror.com ($($_.Exception.Message)); using the system Node.js.\" -ForegroundColor Yellow",
    "  } finally {",
    "    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue",
    "    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue",
    "  }",
    "}",
    "$node = Get-Command node.exe -ErrorAction SilentlyContinue",
    "if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }",
    "$nodeCandidates = @((Install-BatonNode), $node.Source)",
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
    // A public install keeps an earlier pairing with the same server; otherwise the computer joins an account first.
    "if (-not $config.apiKey -and $existingConfig.server -eq $config.server) { foreach ($k in 'apiKey', 'accountKey', 'accountKeyAt', 'accounts') { if ($existingConfig.$k) { $config[$k] = $existingConfig.$k } } }",
    // A dropped pairing stays recoverable from a backup.
    "if ($existingConfig.apiKey -and $config.apiKey -ne $existingConfig.apiKey) { Copy-Item $configPath ($configPath + '.bak-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()) }",
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)",
    // `pair` joins an account, or shows a paired computer's one-time code for a new phone (a keyed install
    // without K has none). Windows PowerShell turns a captured native stderr line into an error under 'Stop',
    // so a paired install must not stop there.
    "if (-not $config.apiKey -or $config.accountKey) {",
    "  $ErrorActionPreference = 'Continue'; & $nodePath (Join-Path $dir 'bridge.mjs') pair; $pairExit = $LASTEXITCODE; $ErrorActionPreference = 'Stop'",
    "  if ($pairExit -ne 0 -and -not $config.apiKey) { throw 'This computer has not joined an account.' }",
    "}",
    "$bridge = Join-Path $dir 'bridge-launcher.mjs'",
    "$logPath = Join-Path $dir 'bridge.log'",
    "Remove-Item $logPath -Force -ErrorAction SilentlyContinue",
    "$wrapper = Join-Path $dir 'run-bridge.cmd'",
    "$userNode = @($nodePath) + $nodeCandidates | Where-Object { $_ -and $_ -notlike '*\\.baton-bridge\\node\\*' -and (Test-Path $_) } | Select-Object -First 1",
    "$wrapperLines = @(",
    "  '@echo off',",
    "  ('set \"USERPROFILE=' + $targetHome + '\"'),",
    "  ('set \"HOME=' + $targetHome + '\"'),",
    // The user's Node.js stays on PATH; the Bridge puts its own node before it for harnesses.
    "  $(if ($userNode) { 'set \"PATH=' + (Split-Path $userNode) + ';%PATH%\"' }),",
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
    // The service runs the new version now: earlier private runtimes go.
    "Get-ChildItem (Join-Path $dir 'node') -Directory -ErrorAction SilentlyContinue | Where-Object Name -ne '" + NODE_VERSION + "' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue",
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
  // Use x-forwarded headers from API GW if available
  const proto = headers.get('x-forwarded-proto') ?? 'http';
  const server = `${proto}://${headers.get('host') ?? ''}/v1`;
  if (platform.toLowerCase() === 'windows') return { text: windowsInstallScript(url, server, apiKey, name) };
  const nameBlock = unixDeviceNameBlock(server, apiKey, name);
  const script = (
    '#!/bin/bash\n' +
    'set -e\n' +
    '\n' +
    '# SSM run-command and cloud-init run without HOME.\n' +
    'export HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"\n' +
    'DIR="$HOME/.baton-bridge"\n' +
    'USER_NODE=$(command -v node || true)\n' +
    'USER_NODE_DIR=${USER_NODE:+$(dirname "$USER_NODE")}\n' +
    unixPrivateNode + '\n' +
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
    nameBlock + '\n' +
    'NODE=$(command -v node)\n' +
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
    'if(!config.apiKey&&existing.server===config.server)for(const k of ["apiKey","accountKey","accountKeyAt","accounts"])if(existing[k])config[k]=existing[k];' +
    // A dropped pairing stays recoverable from a backup.
    'if(existing.apiKey&&config.apiKey!==existing.apiKey)fs.writeFileSync(p+".bak-"+Date.now(),JSON.stringify(existing,null,2),{mode:0o600});' +
    'fs.writeFileSync(p,JSON.stringify(config,null,2),{mode:0o600});fs.chmodSync(p,0o600);\' "$DIR/config.json"\n' +
    // `pair` joins an account (QR code) before the service starts; a paired computer shows a one-time code for a
    // new phone and continues if it cannot (no terminal); a keyed install without K has no code to show.
    'case $(node -p \'const c=require(process.argv[1]);c.apiKey?(c.accountKey?"paired":"keyed"):"new"\' "$DIR/config.json") in\n' +
    '  new) node "$DIR/bridge.mjs" pair ;;\n' +
    '  paired) node "$DIR/bridge.mjs" pair || true ;;\n' +
    'esac\n' +
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
    '    <key>PATH</key><string>${USER_NODE_DIR:+$USER_NODE_DIR:}/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n' +
    '  </dict>\n' +
    '  <key>RunAtLoad</key><true/>\n' +
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n' +
    '  <key>StandardOutPath</key><string>$DIR/bridge.log</string>\n' +
    '  <key>StandardErrorPath</key><string>$DIR/bridge.log</string>\n' +
    '</dict></plist>\n' +
    'PLIST_EOF\n' +
    '  launchctl unload "$PLIST" 2>/dev/null || true\n' +
    '  launchctl load "$PLIST"\n' +
    '  launchctl list com.baton.bridge >/dev/null 2>&1 && prune_private_node\n' +
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
    '  export XDG_RUNTIME_DIR=/run/user/$(id -u)\n' +
    // The private runtime replaces the user's Node: their Node joins the user manager's PATH, after the Bridge's own.
    '  MANAGER_PATH=$(systemctl --user show-environment 2>/dev/null | sed -n "s/^PATH=//p")\n' +
    '  SERVICE_PATH=""\n' +
    '  [ -n "$USER_NODE_DIR" ] && [ "$NODE" != "$USER_NODE" ] &&\n' +
    '    SERVICE_PATH="Environment=\\"PATH=$USER_NODE_DIR:${MANAGER_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}\\""\n' +
    '  mkdir -p "$SERVICE_DIR"\n' +
    '  cat > "$SERVICE_DIR/baton-bridge.service" << SVC_EOF\n' +
    '[Unit]\n' +
    'Description=Baton Bridge\n' +
    'After=network.target\n' +
    '[Service]\n' +
    'ExecStart=$NODE $DIR/bridge.mjs\n' +
    '$SERVICE_PATH\n' +
    'Restart=on-failure\n' +
    'RestartSec=5\n' +
    'KillMode=process\n' +
    '[Install]\n' +
    'WantedBy=default.target\n' +
    'SVC_EOF\n' +
    '  sudo loginctl enable-linger $(whoami) 2>/dev/null || loginctl enable-linger $(whoami) 2>/dev/null || true\n' +
    '  systemctl --user daemon-reload\n' +
    '  systemctl --user enable baton-bridge\n' +
    '  systemctl --user restart baton-bridge\n' +
    '  systemctl --user is-active --quiet baton-bridge && prune_private_node\n' +
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
