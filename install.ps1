# Installs Jean Code and everything it runs on: Bun, the Rust toolchain, the
# native core, the debuggers, and the common language servers.
#
#   .\install.ps1               from a checkout
#   irm https://raw.githubusercontent.com/jean-code/jean-code/main/install.ps1 | iex
#
# Options:
#   -All       every debugger and language server that installs itself, not
#              only the ones for the languages found on this machine
#   -NoRust    do not install Rust; Jean runs on its TypeScript fallbacks
#   -NoTools   skip debuggers and language servers (`jean setup` later)
#
# Everything Jean installs goes under ~\.jean; the `jean` command goes next to
# `bun`, in ~\.bun\bin.
param([switch]$All, [switch]$NoRust, [switch]$NoTools)
$ErrorActionPreference = 'Stop'

$Repo = if ($env:JEAN_REPO) { $env:JEAN_REPO } else { 'https://github.com/jean-code/jean-code.git' }
$HomeDir = if ($env:JEAN_INSTALL_DIR) { $env:JEAN_INSTALL_DIR } else { Join-Path $HOME '.jean\jean-code' }
$Setup = if ($All) { 'all' } else { 'default' }

function Say($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Warn($text) { Write-Host "!   $text" -ForegroundColor Yellow }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Add-ToPath($dir) {
  if (($env:PATH -split ';') -notcontains $dir) { $env:PATH = "$dir;$env:PATH" }
}

# 1. The checkout: this one when run from it, otherwise a clone kept current.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { '' }
if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir 'packages\cli\src\index.ts'))) {
  $Root = $ScriptDir
} else {
  if (-not (Have git)) { Warn 'git is needed to fetch Jean Code: https://git-scm.com'; exit 1 }
  if (Test-Path (Join-Path $HomeDir '.git')) {
    Say "Updating $HomeDir"
    git -C $HomeDir pull --ff-only
  } else {
    Say "Cloning Jean Code into $HomeDir"
    New-Item -ItemType Directory -Force (Split-Path $HomeDir) | Out-Null
    git clone --depth 1 $Repo $HomeDir
  }
  $Root = $HomeDir
}
Set-Location $Root

# 2. Bun runs Jean.
$BunBin = Join-Path $HOME '.bun\bin'
if (-not (Have bun)) {
  if (-not (Test-Path (Join-Path $BunBin 'bun.exe'))) {
    Say 'Installing Bun'
    powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex'
  }
  Add-ToPath $BunBin
}

# 3. Rust builds the native core — search, edits, the shell, LSP, and DAP.
$CargoBin = Join-Path $HOME '.cargo\bin'
if (-not $NoRust -and -not (Have cargo)) {
  if (-not (Test-Path (Join-Path $CargoBin 'cargo.exe'))) {
    Say 'Installing Rust (rustup)'
    $Init = Join-Path $env:TEMP 'rustup-init.exe'
    Invoke-WebRequest 'https://win.rustup.rs/x86_64' -OutFile $Init
    & $Init -y --profile minimal
    Remove-Item $Init -Force
  }
  Add-ToPath $CargoBin
  if (-not (Test-Path "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe")) {
    Warn 'Rust on Windows links with the MSVC build tools: winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"'
  }
}

# 4. Dependencies.
Say 'Installing dependencies'
bun install
if ($LASTEXITCODE -ne 0) { Warn 'bun install failed'; exit 1 }

# 5. The native core, debuggers, and language servers.
if ($NoTools) {
  Say 'Building the native core'
  bun packages/cli/src/index.ts setup native
  if ($LASTEXITCODE -ne 0) { Warn 'the native build failed; Jean runs on its TypeScript fallbacks' }
} else {
  Say 'Setting up the native core, debuggers, and language servers'
  bun packages/cli/src/index.ts setup $Setup
  if ($LASTEXITCODE -ne 0) { Warn 'some steps failed; run `jean setup` to retry' }
}

# 6. The `jean` command, beside `bun`.
New-Item -ItemType Directory -Force $BunBin | Out-Null
$Entry = Join-Path $Root 'packages\cli\src\index.ts'
Set-Content -Path (Join-Path $BunBin 'jean.cmd') -Encoding ascii -Value "@bun `"$Entry`" %*"
Say "Installed ``jean`` in $BunBin"
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $BunBin) {
  [Environment]::SetEnvironmentVariable('Path', "$BunBin;$UserPath", 'User')
  Say "Added $BunBin to your PATH (new terminals see it)"
}

Write-Host ''
Write-Host 'Done. Set a key ($env:OPENROUTER_API_KEY = "...") and run: jean'
