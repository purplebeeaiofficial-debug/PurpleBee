param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("dev", "deploy", "whoami")]
  [string]$Action
)

$nodeDir = "C:\Program Files\nodejs"
$npmBin = Join-Path $env:APPDATA "npm"
$wranglerCmd = Join-Path $npmBin "wrangler.cmd"
$authPath = Join-Path $PSScriptRoot "cf-auth.local.json"
$legacyAuthPath = Join-Path $PSScriptRoot "cf-auth.local.cmd"

$env:Path = "$nodeDir;$npmBin;$env:Path"
Set-Location $PSScriptRoot

if (Test-Path $legacyAuthPath) {
  Remove-Item -Force $legacyAuthPath -ErrorAction SilentlyContinue
}

if (-not (Test-Path $wranglerCmd)) {
  Write-Host "[ERROR] Wrangler is not installed."
  Write-Host "Run: npm install -g wrangler"
  exit 1
}

if (-not (Test-Path $authPath)) {
  Write-Host "[ERROR] cf-auth.local.json was not found."
  Write-Host "Run setup_token.bat first."
  exit 1
}

try {
  $auth = Get-Content -Raw -Path $authPath | ConvertFrom-Json
}
catch {
  Write-Host "[ERROR] Could not read cf-auth.local.json"
  Write-Host $_.Exception.Message
  exit 1
}

if ([string]::IsNullOrWhiteSpace($auth.account_id) -or [string]::IsNullOrWhiteSpace($auth.api_token)) {
  Write-Host "[ERROR] Credentials are empty. Run setup_token.bat again."
  exit 1
}

$env:CLOUDFLARE_ACCOUNT_ID = [string]$auth.account_id
$env:CLOUDFLARE_API_TOKEN = [string]$auth.api_token

if ($Action -eq "dev" -or $Action -eq "deploy") {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "sync-public-assets.ps1")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to refresh Cloudflare public assets."
    exit $LASTEXITCODE
  }
}

switch ($Action) {
  "dev" {
    Write-Host ""
    Write-Host "[RUN] wrangler dev --remote"
    & $wranglerCmd "dev" "--remote"
    exit $LASTEXITCODE
  }
  "deploy" {
    Write-Host ""
    Write-Host "[DEPLOY] wrangler deploy"
    & $wranglerCmd "deploy"
    exit $LASTEXITCODE
  }
  "whoami" {
    & $wranglerCmd "whoami"
    exit $LASTEXITCODE
  }
}
