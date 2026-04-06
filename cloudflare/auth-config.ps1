param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("setup")]
  [string]$Action
)

$authPath = Join-Path $PSScriptRoot "cf-auth.local.json"

if ($Action -eq "setup") {
  Write-Host ""
  Write-Host "=========================================="
  Write-Host "  Purple Bee AI - Cloudflare Token Setup"
  Write-Host "=========================================="
  Write-Host ""
  Write-Host "Prepare these two values from the Cloudflare Dashboard:"
  Write-Host "1. Account ID"
  Write-Host "2. API Token (with Workers deploy permissions)"
  Write-Host ""

  $accountId = (Read-Host "Cloudflare Account ID").Trim()
  if ([string]::IsNullOrWhiteSpace($accountId)) {
    Write-Host "[ERROR] Account ID is empty."
    exit 1
  }

  $secureToken = Read-Host "Cloudflare API Token" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $apiToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }

  if ([string]::IsNullOrWhiteSpace($apiToken)) {
    Write-Host "[ERROR] API Token is empty."
    exit 1
  }

  $payload = [ordered]@{
    account_id = $accountId
    api_token  = $apiToken
  } | ConvertTo-Json -Depth 3

  Set-Content -Path $authPath -Value $payload -Encoding utf8

  Write-Host ""
  Write-Host "[DONE] Saved credentials to cf-auth.local.json"
  Write-Host "Now run dev_cloudflare.bat or deploy_cloudflare.bat"
}
