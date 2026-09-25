# Installs Jean Code.
#
#   irm https://raw.githubusercontent.com/hackerxj2010/Jean_Code/main/install.ps1 | iex
#   .\install.ps1               from a checkout: builds that checkout
#
# Run on its own, it downloads the prebuilt Jean for this machine into
# ~\.jean\bin — one program, nothing else needed. From a checkout, or with
# -Source, it builds from source instead, installing Bun, the Rust toolchain,
# the native core, the debuggers, and the common language servers.
#
# Options:
#   -Source    build from source even when a prebuilt release exists
#   -Version V a specific release (default: the latest)
#   -All       (source) every debugger and language server that installs
#              itself, not only those for the languages on this machine
#   -NoRust    (source) do not install Rust; Jean runs on its TypeScript fallbacks
#   -NoTools   (source) skip debuggers and language servers (`jean setup` later)
#
# The prebuilt Jean lives in ~\.jean\bin; a source build's `jean` goes next to
# `bun`, in ~\.bun\bin.
param([switch]$Source, [string]$Version = $env:JEAN_VERSION, [switch]$All, [switch]$NoRust, [switch]$NoTools)
$ErrorActionPreference = 'Stop'

$GitHub = if ($env:JEAN_GITHUB) { $env:JEAN_GITHUB } else { 'hackerxj2010/Jean_Code' }
$Repo = if ($env:JEAN_REPO) { $env:JEAN_REPO } else { "https://github.com/$GitHub.git" }
$HomeDir = if ($env:JEAN_INSTALL_DIR) { $env:JEAN_INSTALL_DIR } else { Join-Path $HOME '.jean\jean-code' }
$Setup = if ($All) { 'all' } else { 'default' }

function Say($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Warn($text) { Write-Host "!   $text" -ForegroundColor Yellow }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Add-ToPath($dir) {
  if (($env:PATH -split ';') -notcontains $dir) { $env:PATH = "$dir;$env:PATH" }
}

function Add-ToUserPath($dir) {
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($UserPath -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', "$dir;$UserPath", 'User')
    Say "Added $dir to your PATH (new terminals see it)"
  }
  Add-ToPath $dir
}

# The prebuilt release: which platform this is, then download and unpack it.
# Returns $false, without changing anything, when there is none to use.
function Install-Release {
  $cpu = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { $null }
  }
  # A 32-bit or emulated shell reports its own architecture; this is the machine's.
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $cpu = 'arm64' }
  elseif ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { $cpu = 'x64' }
  if (-not $cpu) { Warn "no prebuilt Jean for $env:PROCESSOR_ARCHITECTURE"; return $false }

  $file = "jean-win32-$cpu.zip"
  $url = if ($env:JEAN_RELEASE_URL) { "$env:JEAN_RELEASE_URL/$file" }
    elseif ($Version) { "https://github.com/$GitHub/releases/download/v$($Version.TrimStart('v'))/$file" }
    else { "https://github.com/$GitHub/releases/latest/download/$file" }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("jean-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    Say "Downloading $file"
    try {
      $ProgressPreference = 'SilentlyContinue' # the progress bar makes large downloads many times slower
      Invoke-WebRequest $url -OutFile (Join-Path $tmp $file) -UseBasicParsing
    } catch {
      Warn "no prebuilt release at $url"
      return $false
    }
    Expand-Archive (Join-Path $tmp $file) -DestinationPath (Join-Path $tmp 'jean') -Force

    # Replaced whole, so no file from an older version is left behind — but
    # only once the new one has unpacked.
    $Bin = Join-Path $HOME '.jean\bin'
    New-Item -ItemType Directory -Force $Bin | Out-Null
    $OldSkills = Join-Path $Bin 'skills'
    if (Test-Path $OldSkills) { Remove-Item $OldSkills -Recurse -Force }
    Copy-Item (Join-Path $tmp 'jean\*') $Bin -Recurse -Force
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $Exe = Join-Path $Bin 'jean.exe'
  Say "Installed $(& $Exe --version) in $Bin"
  Add-ToUserPath $Bin
  Write-Host ''
  Write-Host 'Done. Give it a key with `jean auth login openrouter` (or another provider), then run: jean'
  return $true
}

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { '' }
$InCheckout = [bool]($ScriptDir -and (Test-Path (Join-Path $ScriptDir 'packages\cli\src\index.ts')))
if (-not $Source -and -not $InCheckout) {
  if (Install-Release) { return }
  Say 'Building from source instead'
}

# 1. The checkout: this one when run from it, otherwise a clone kept current.
if ($InCheckout) {
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
Add-ToUserPath $BunBin

Write-Host ''
Write-Host 'Done. Set a key ($env:OPENROUTER_API_KEY = "...") and run: jean'
