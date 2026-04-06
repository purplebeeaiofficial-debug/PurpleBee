Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cfDir = $PSScriptRoot
$pkgDir = Join-Path $root "Model\versions\purple-bee-1-3\browser_package"
$hfAuthPath = Join-Path $cfDir "hf-auth.local.json"
$cfAuthPath = Join-Path $cfDir "cf-auth.local.json"
$repoName = "purple-bee-1-3"
$workerName = "purple-bee-cloudflare"

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  return Get-Content -Path $Path -Raw | ConvertFrom-Json
}

function Write-JsonFile {
  param([string]$Path, [object]$Payload)
  $dir = Split-Path -Parent $Path
  if ($dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $json = $Payload | ConvertTo-Json -Depth 10
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

$hfAuth = Read-JsonFile $hfAuthPath
$cfAuth = Read-JsonFile $cfAuthPath
$hfUser = if ($hfAuth -and $hfAuth.username) { [string]$hfAuth.username } else { [string]$env:HF_USER }
$hfToken = if ($hfAuth -and $hfAuth.token) { [string]$hfAuth.token } else { [string]$env:HF_TOKEN }
$cfToken = if ($cfAuth -and $cfAuth.api_token) { [string]$cfAuth.api_token } else { "" }
$cfAccount = if ($cfAuth -and $cfAuth.account_id) { [string]$cfAuth.account_id } else { "" }

if ([string]::IsNullOrWhiteSpace($hfUser) -or [string]::IsNullOrWhiteSpace($hfToken)) {
  throw "Missing Hugging Face credentials."
}

if ([string]::IsNullOrWhiteSpace($cfToken) -or [string]::IsNullOrWhiteSpace($cfAccount)) {
  throw "Missing Cloudflare credentials."
}

$onnxFile = Get-ChildItem -Path $pkgDir -Filter "*.onnx" | Select-Object -First 1
$tokenizerFile = Join-Path $pkgDir "tokenizer.json"
if (-not $onnxFile) { throw "No ONNX file found in $pkgDir" }
if (-not (Test-Path $tokenizerFile)) { throw "Missing tokenizer.json in $pkgDir" }

$repoId = "$hfUser/$repoName"
$baseUrl = "https://huggingface.co/$repoId/resolve/main"

Write-Host "[1/4] Uploading tokenizer and ONNX to Hugging Face..."
python (Join-Path $cfDir "hf_upload.py")

Write-Host "[2/4] Refreshing public assets..."
& (Join-Path $cfDir "sync-public-assets.ps1")

Write-Host "[3/4] Deploying Worker..."
$env:CLOUDFLARE_API_TOKEN = $cfToken
Set-Location $cfDir
& npx wrangler deploy --config wrangler.toml

Write-Host "[4/4] Writing local deploy config..."
Write-JsonFile -Path (Join-Path $cfDir "model-deploy.local.json") -Payload @{
  public_base_url = $baseUrl
  storage = "hf-hub"
}

Write-Host ""
Write-Host "Done."
Write-Host "HF repo: https://huggingface.co/$repoId"
Write-Host "ONNX: $baseUrl/$($onnxFile.Name)"
