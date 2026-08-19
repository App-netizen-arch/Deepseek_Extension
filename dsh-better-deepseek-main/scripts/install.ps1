# =============================================================================
# dsh-better-deepseek Dual Installer (Web / Local) (Windows PowerShell 5.1+ / pwsh)
#
# Supports both:
#   1. Remote install from npm registry via DSH CLI:
#      irm https://raw.githubusercontent.com/EdgeTypE/dsh-better-deepseek/main/scripts/install.ps1 | iex
#   2. Local development install from source directory:
#      powershell -ExecutionPolicy Bypass -File install.ps1 -LocalPath "C:\Users\YOUR_USERNAME\GitHub\deepseek-harness\packages\extensions\better-deepseek"
# =============================================================================
param(
  [string]$Version = '',
  [string]$LocalPath = '',
  [switch]$Restart,
  [switch]$DryRun
)

$PKG = 'dsh-better-deepseek'
$REGISTRY = if ($env:REGISTRY) { $env:REGISTRY } else { 'https://registry.npmjs.org' }

# DSH_HOME resolution
if ($env:DSH_HOME) {
  $DSH_HOME = $env:DSH_HOME
}
elseif ($env:USERPROFILE) {
  $DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
}
else {
  $DSH_HOME = Join-Path $HOME '.dsh'
}
$PROFILE_DIR = Join-Path $DSH_HOME 'profiles\web'
$PROFILE_NM = Join-Path $DSH_HOME 'profiles\node_modules'
$WS_YML = Join-Path $PROFILE_DIR 'pnpm-workspace.yaml'
$PATCH_YML = Join-Path $PROFILE_DIR 'cordis.patch.yml'
$PKG_JSON = Join-Path $PROFILE_DIR 'package.json'

function Say([string]$m) { Write-Host "[install] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

# Resolve version from npm
function Resolve-Spec {
  param([string]$Given)
  if ([string]::IsNullOrWhiteSpace($Given) -or $Given -eq 'latest') {
    $v = $null
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      $raw = & npm view $PKG version "--registry=$REGISTRY" 2>$null
      if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($raw) -and -not ($raw -like "*help*")) {
        $v = $raw.Trim()
      }
    }
    if ($v) { return $v }
    return 'latest'
  }
  return $Given
}

# Resolve DSH CLI
function Get-DshCli {
  if ($env:DSH_CMD) { return $env:DSH_CMD }
  if (Get-Command dsh -ErrorAction SilentlyContinue) { return 'dsh' }
  if (Get-Command npx -ErrorAction SilentlyContinue) { return 'npx' }
  return $null
}

# Prerequisites
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die 'Node.js not found (Node.js >= 20 is required). Please install Node.js.'
}
if (-not (Test-Path $PROFILE_DIR)) {
  Die "Profile directory not found: $PROFILE_DIR (Please run 'npx @deepseek-ai/dsh web' at least once)."
}

# -----------------------------------------------------------------------------
# MODE A: LOCAL INSTALLATION (from local source directory)
# -----------------------------------------------------------------------------
if (-not [string]::IsNullOrWhiteSpace($LocalPath)) {
  if (-not (Test-Path $LocalPath)) {
    Die "Specified LocalPath does not exist: $LocalPath"
  }
  $resolvedLocalPath = (Resolve-Path $LocalPath).Path
  Say "Running in LOCAL mode using source: $resolvedLocalPath"

  if ($DryRun) {
    Say "[dry-run] Link $PROFILE_NM\dsh-better-deepseek -> $resolvedLocalPath"
    Say "[dry-run] Register $PKG in $PKG_JSON (dsh.profile.bundles)"
    exit 0
  }

  # 1. Ensure target directory exists
  if (-not (Test-Path $PROFILE_NM)) {
    New-Item -ItemType Directory -Path $PROFILE_NM -Force | Out-Null
  }

  # 2. Create Directory Junction (works on Windows without admin rights)
  $targetLink = Join-Path $PROFILE_NM 'dsh-better-deepseek'
  Say "Creating link: $targetLink -> $resolvedLocalPath"
  if (Test-Path $targetLink) {
    Remove-Item -LiteralPath $targetLink -Force -Recurse -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Junction -Path $targetLink -Target $resolvedLocalPath -Force | Out-Null

  # 3. Add to dsh.profile.bundles in profile package.json (UTF-8 without BOM)
  if (Test-Path $PKG_JSON) {
    $nodeScript = @'
const fs = require("fs");
const p = process.argv[2];
const pkg = process.argv[3];
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch {}
if (!obj.dsh) obj.dsh = {};
if (!obj.dsh.profile) obj.dsh.profile = {};
if (!obj.dsh.profile.bundles) obj.dsh.profile.bundles = [];
if (!obj.dsh.profile.bundles.includes(pkg)) {
  obj.dsh.profile.bundles.push(pkg);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
'@
    $nodeTmp = Join-Path $env:TEMP ("dshbd-pkg-" + [guid]::NewGuid().ToString("N") + ".js")
    Set-Content -LiteralPath $nodeTmp -Value $nodeScript -Encoding UTF8
    node $nodeTmp "$PKG_JSON" "$PKG"
    Remove-Item -LiteralPath $nodeTmp -Force -ErrorAction SilentlyContinue
    Say "Added $PKG to $PKG_JSON (dsh.profile.bundles)."
  }

  Say "Local installation complete! ✨"
  if ($Restart) {
    if (Get-Command pm2 -ErrorAction SilentlyContinue) {
      Say 'Restarting dsh-web...'
      pm2 restart dsh-web
    }
  }
  exit 0
}

# -----------------------------------------------------------------------------
# MODE B: REMOTE NPM INSTALLATION (via DSH CLI)
# -----------------------------------------------------------------------------
if (-not (Test-Path $WS_YML)) {
  New-Item -ItemType File -Path $WS_YML -Force | Out-Null
  Set-Content -Path $WS_YML -Value "packages:`n  - '.'`n" -Encoding UTF8
}

$SPEC = Resolve-Spec $Version
$CLI = Get-DshCli
if (-not $CLI) {
  Die 'Neither dsh nor npx was found.'
}
Say "Running in REMOTE mode: $CLI plugin --profile web add $PKG@$SPEC"

if ($DryRun) {
  Say "[dry-run] Configure $WS_YML (allowBuilds + minimumReleaseAgeExclude)"
  Say "[dry-run] Run $CLI plugin --profile web add $PKG@$SPEC"
  exit 0
}

# Step 1: Workspace setup (idempotent, ensures pnpm allows builds)
$wsScript = @'
const fs = require("fs");
const p = process.argv[2];
let t = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const before = t;
t = t.replace(/^(\s*)(node-pty|protobufjs):.*$/gm, "$1$2: true");
if (!/^\s*allowBuilds:\s*$/m.test(t)) {
  t += "\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n";
} else {
  for (const k of ["node-pty", "protobufjs"]) {
    if (!new RegExp("^\\s*" + k + ":\\s*true\\s*$", "m").test(t)) {
      t = t.replace(/^(\s*allowBuilds:\s*)$/m, "$1\n  " + k + ": true");
    }
  }
}
if (!/^\s*-\s+dsh-better-deepseek\s*$/m.test(t)) {
  if (/^\s*minimumReleaseAgeExclude:\s*$/m.test(t)) {
    t = t.replace(/^(\s*minimumReleaseAgeExclude:\s*)$/m, "$1\n  - dsh-better-deepseek");
  } else {
    t += "\nminimumReleaseAgeExclude:\n  - dsh-better-deepseek\n";
  }
}
if (t !== before) fs.writeFileSync(p, t);
console.log(t === before ? "unchanged" : "updated");
'@
$wsJs = Join-Path $env:TEMP ("dshbd-ws-" + [guid]::NewGuid().ToString("N") + ".js")
Set-Content -LiteralPath $wsJs -Value $wsScript -Encoding UTF8
$wsOut = node $wsJs "$WS_YML" 2>&1
$wsCode = $LASTEXITCODE
Remove-Item -LiteralPath $wsJs -Force -ErrorAction SilentlyContinue
$wsResult = (($wsOut | Out-String)).Trim()
if ($wsCode -ne 0) { Die "Failed to configure $WS_YML ($wsCode): $wsResult" }

# Step 2: Official CLI Installation
if ($CLI -eq 'dsh') {
  $cliArgs = @('plugin', '--profile', 'web', 'add', "$PKG@$SPEC")
}
else {
  $cliArgs = @('-y', '--package', '@deepseek-ai/dsh', 'dsh', 'plugin', '--profile', 'web', 'add', "$PKG@$SPEC")
}
Say "Running $CLI plugin --profile web add $PKG@$SPEC ..."
$addOut = & $CLI @cliArgs 2>&1
$addCode = $LASTEXITCODE
$addOut | ForEach-Object { $_ }
if ($addCode -ne 0) {
  Warn 'dsh plugin add failed. Note: If the package is not yet published to npm, use -LocalPath parameter for local installation.'
  exit 1
}

Say "Installation complete: $PKG@$SPEC ✨"

if ($Restart) {
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Say 'Restarting dsh-web via pm2...'
    pm2 restart dsh-web
  }
}
else {
  Say "Next step: Restart your DSH server ('npx @deepseek-ai/dsh web')."
}
