# Idempotent QLB installer for Windows.
# Safe to re-run: npm ci/install, build, optional global link, then `qlb init`.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Write-InstallError {
  param([string]$Message)
  [Console]::Error.WriteLine($Message)
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-InstallError 'qlb install: Node.js is required (need >= 22).'
  exit 1
}

$nodeMajor = [int](& node -p "Number.parseInt(process.versions.node, 10)")
if ($nodeMajor -lt 22) {
  $found = & node -v
  Write-InstallError "qlb install: Node.js >= 22 is required (found $found)."
  exit 1
}

if (Test-Path -LiteralPath 'package-lock.json') {
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  npm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$linked = $false
npm link
if ($LASTEXITCODE -eq 0) {
  $linked = $true
} else {
  Write-Host 'qlb install: npm link failed (often a permissions issue).'
  Write-Host '  Fallback options:'
  Write-Host "    - add $Root\dist to your PATH, then run: node $Root\dist\cli.js"
  Write-Host '    - re-run from an elevated prompt if you intended a global install'
  Write-Host "    - use npx: npx --prefix $Root qlb"
}

$qlb = Get-Command qlb -ErrorAction SilentlyContinue
if ($linked -and $qlb) {
  qlb init
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  node dist/cli.js init
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host 'qlb install: done.'
