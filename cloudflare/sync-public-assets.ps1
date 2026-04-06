Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root "app"
$publicDir = Join-Path $PSScriptRoot "public"
$publicStaticDir = Join-Path $publicDir "static"
$vendorSourceDir = Join-Path $appDir "static\vendor"
$vendorDestDir = Join-Path $publicStaticDir "vendor"
$manifestSourceDir = Join-Path $appDir "static\manifests"
$manifestDestDir = Join-Path $publicStaticDir "manifests"
$safeAssetLimit = 25MB

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  return Get-Content -Path $Path -Raw | ConvertFrom-Json
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Payload
  )
  $dir = Split-Path -Parent $Path
  if ($dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $json = $Payload | ConvertTo-Json -Depth 10
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Remove-PathIfExists {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-Item -Path $Path -Recurse -Force
  }
}

New-Item -ItemType Directory -Path $publicStaticDir -Force | Out-Null

Copy-Item -Path (Join-Path $appDir "templates\index.html") -Destination (Join-Path $publicDir "index.html") -Force
$landingRoot = Join-Path $publicDir "ko-KR\index\purple-bee"
New-Item -ItemType Directory -Path $landingRoot -Force | Out-Null
Copy-Item -Path (Join-Path $appDir "templates\purplebee-landing.html") -Destination (Join-Path $landingRoot "index.html") -Force

$landingPages = @(
  @{ source = "purplebee-landing-features.html"; destination = "features\index.html" },
  @{ source = "purplebee-landing-safety.html"; destination = "safety\index.html" },
  @{ source = "purplebee-landing-architecture.html"; destination = "architecture\index.html" },
  @{ source = "purplebee-landing-pricing.html"; destination = "pricing\index.html" }
)

foreach ($page in $landingPages) {
  $target = Join-Path $landingRoot $page.destination
  $targetDir = Split-Path -Parent $target
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  Copy-Item -Path (Join-Path $appDir "templates\$($page.source)") -Destination $target -Force
}

$staticFiles = @(
  "purple-bee-browser-runtime.js",
  "purple-bee-engine.js",
  "purple-bee-local.js",
  "purple-bee-model.bin"
)

foreach ($file in $staticFiles) {
  Copy-Item -Path (Join-Path $appDir "static\$file") -Destination (Join-Path $publicStaticDir $file) -Force
}

if (Test-Path $vendorSourceDir) {
  Remove-PathIfExists -Path $vendorDestDir
  Copy-Item -Path $vendorSourceDir -Destination $vendorDestDir -Recurse -Force
}

if (Test-Path $manifestSourceDir) {
  Remove-PathIfExists -Path $manifestDestDir
  Copy-Item -Path $manifestSourceDir -Destination $manifestDestDir -Recurse -Force
}

$registrySourceCandidates = @(
  (Join-Path $appDir "static\model-registry.json"),
  (Join-Path $root "Model\registry.json")
)
$registryPath = $null
foreach ($candidate in $registrySourceCandidates) {
  if (Test-Path $candidate) {
    $registryPath = $candidate
    break
  }
}
$registry = Read-JsonFile -Path $registryPath
if ($registry -and $registryPath) {
  Copy-Item -Path $registryPath -Destination (Join-Path $publicStaticDir "model-registry.json") -Force
}

$deployConfigPath = Join-Path $PSScriptRoot "model-deploy.local.json"
$deployConfig = Read-JsonFile -Path $deployConfigPath
$publicBackendConfig = [ordered]@{
  configured = $false
  public_api_base_url = ""
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
}
if ($deployConfig -and $deployConfig.PSObject.Properties["public_backend_url"] -and $deployConfig.public_backend_url) {
  $publicBackendConfig.configured = $true
  $publicBackendConfig.public_api_base_url = ([string]$deployConfig.public_backend_url).TrimEnd("/")
}
Write-JsonFile -Path (Join-Path $publicStaticDir "public-backend.json") -Payload $publicBackendConfig

$dialogueSource = Join-Path $root "Model\corpora\purple_bee_public_dialogues.txt"
if ($registry -and $registry.current_model_id) {
  $teacherDialoguePath = Join-Path $root ("Model\versions\{0}\training\teacher_public_dialogues.txt" -f $registry.current_model_id)
  if (Test-Path $teacherDialoguePath) {
    $dialogueSource = $teacherDialoguePath
  }
}
if (Test-Path $dialogueSource) {
  Copy-Item -Path $dialogueSource -Destination (Join-Path $publicStaticDir "purple-bee-dialogues.txt") -Force
}

$dialoguePackSourceFiles = @(
  (Join-Path $root "Model\corpora\dialogue_sft\chat_quality_pack_ko.jsonl"),
  (Join-Path $root "Model\corpora\dialogue_sft\dialogue_followup_repair_ko.jsonl")
)
$dialoguePackItems = @()
foreach ($sourceFile in $dialoguePackSourceFiles) {
  if (-not (Test-Path $sourceFile)) { continue }
  foreach ($line in Get-Content -Path $sourceFile -Encoding UTF8) {
    $trimmed = ([string]$line).Trim()
    if (-not $trimmed) { continue }
    try {
      $row = $trimmed | ConvertFrom-Json
      if (-not $row) { continue }
      $inputValue = [string]$row.input
      $responseValue = [string]$row.response
      if (-not $inputValue -or -not $responseValue) { continue }
      $dialoguePackItems += [ordered]@{
        input = $inputValue
        response = $responseValue
        tags = @($row.tags)
        language = [string]$row.language
        reward_weight = if ($row.PSObject.Properties["reward_weight"]) { [int]$row.reward_weight } else { 0 }
      }
    } catch {
      # Ignore malformed lines.
    }
  }
}
if ($dialoguePackItems.Count -gt 0) {
  Write-JsonFile -Path (Join-Path $publicStaticDir "purple-bee-dialogues.json") -Payload ([ordered]@{
    family_name = "Purple Bee"
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    count = $dialoguePackItems.Count
    items = $dialoguePackItems
  })
}

$browserManifestOut = Join-Path $publicStaticDir "browser-manifest.json"
$modelDestRoot = Join-Path $publicStaticDir "models"
Remove-PathIfExists -Path $browserManifestOut
Remove-PathIfExists -Path $modelDestRoot

if ($registry -and $registry.current_model_id) {
  $currentModelId = [string]$registry.current_model_id
  $packageDir = Join-Path $root ("Model\versions\{0}\browser_package" -f $currentModelId)
  $browserDir = if (Test-Path $packageDir) { $packageDir } else { Join-Path $root ("Model\versions\{0}\browser" -f $currentModelId) }
  $deployConfigPath = Join-Path $PSScriptRoot "model-deploy.local.json"
  $publicBaseUrl = ""
  $storageMode = "auto"
  if ($deployConfig -and $deployConfig.PSObject.Properties["public_base_url"] -and $deployConfig.public_base_url) {
    $publicBaseUrl = [string]$deployConfig.public_base_url
    $publicBaseUrl = $publicBaseUrl.TrimEnd("/")
  }
  if ($deployConfig -and $deployConfig.PSObject.Properties["storage"] -and $deployConfig.storage) {
    $storageMode = [string]$deployConfig.storage
  }
  $providerPreference = @("wasm")
  if ($deployConfig -and $deployConfig.PSObject.Properties["provider_preference"] -and $deployConfig.provider_preference) {
    $candidateProviders = @(@($deployConfig.provider_preference) |
      ForEach-Object { ([string]$_).Trim().ToLower() } |
      Where-Object { $_ -in @("wasm", "webgpu") })
    if ($candidateProviders.Length -gt 0) {
      $providerPreference = $candidateProviders
    }
  }

  if (Test-Path $browserDir) {
    $packagedManifestPath = Join-Path $browserDir "browser-manifest.json"
    $packagedManifest = Read-JsonFile -Path $packagedManifestPath
    $runtimeEngine = ""
    $runtimeNode = $null
    if ($packagedManifest -and $packagedManifest.PSObject.Properties["runtime"]) {
      $runtimeNode = $packagedManifest.PSObject.Properties["runtime"].Value
    }
    if ($runtimeNode -and $runtimeNode.PSObject.Properties["engine"]) {
      $runtimeEngine = ([string]$runtimeNode.PSObject.Properties["engine"].Value).Trim().ToLower()
    }
    $hasRemoteManifest = $false
    $browserAssetsNode = $null
    if ($packagedManifest -and $packagedManifest.PSObject.Properties["browser_assets"]) {
      $browserAssetsNode = $packagedManifest.PSObject.Properties["browser_assets"].Value
    }
    if ($browserAssetsNode) {
      $remoteOnnx = ""
      $remoteTokenizer = ""
      if ($browserAssetsNode.PSObject.Properties["onnx"]) {
        $remoteOnnx = [string]$browserAssetsNode.PSObject.Properties["onnx"].Value
      }
      if ($browserAssetsNode.PSObject.Properties["tokenizer"]) {
        $remoteTokenizer = [string]$browserAssetsNode.PSObject.Properties["tokenizer"].Value
      }
      if ($remoteOnnx -match '^https?://' -and $remoteTokenizer -match '^https?://') {
        $hasRemoteManifest = $true
      }
    }

    if ($packagedManifest -and ($runtimeEngine -eq "transformers-js" -or $hasRemoteManifest)) {
      $runtimeBlock = [ordered]@{}
      if ($runtimeNode) {
        foreach ($prop in $runtimeNode.PSObject.Properties) {
          $runtimeBlock[$prop.Name] = $prop.Value
        }
      }
      $runtimeBlock["provider_preference"] = @($providerPreference)
      if (-not $runtimeBlock.Contains("max_context")) {
        $runtimeBlock["max_context"] = 2048
      }

      $browserAssets = [ordered]@{}
      if ($browserAssetsNode) {
        foreach ($prop in $browserAssetsNode.PSObject.Properties) {
          $browserAssets[$prop.Name] = $prop.Value
        }
      }

      $displayName = ($registry.models | Where-Object { $_.id -eq $currentModelId } | Select-Object -First 1).display_name
      $manifest = [ordered]@{
        family_name = if ($packagedManifest.family_name) { [string]$packagedManifest.family_name } else { [string]$registry.family_name }
        model_id = if ($packagedManifest.model_id) { [string]$packagedManifest.model_id } else { $currentModelId }
        display_name = if ($packagedManifest.display_name) { [string]$packagedManifest.display_name } else { [string]$displayName }
        browser_assets = $browserAssets
        runtime = $runtimeBlock
      }
      Write-JsonFile -Path $browserManifestOut -Payload $manifest
    } else {
    $onnxFile = Get-ChildItem -Path $browserDir -Filter "*.onnx" | Select-Object -First 1
    $tokenizerFile = Get-ChildItem -Path $browserDir -Filter "*tokenizer*.json" | Select-Object -First 1
    if (-not $tokenizerFile) {
      $candidate = Join-Path $browserDir "tokenizer.json"
      if (Test-Path $candidate) {
        $tokenizerFile = Get-Item $candidate
      }
    }
    $onnxDataFile = Get-ChildItem -Path $browserDir -Filter "*.onnx.data" | Select-Object -First 1
    $largestFile = 0
    foreach ($candidate in @($onnxFile, $tokenizerFile, $onnxDataFile)) {
      if ($candidate -and $candidate.Length -gt $largestFile) {
        $largestFile = $candidate.Length
      }
    }

    if ($onnxFile -and $tokenizerFile) {
      $manifest = [ordered]@{
        family_name = $registry.family_name
        model_id = $currentModelId
        display_name = ($registry.models | Where-Object { $_.id -eq $currentModelId } | Select-Object -First 1).display_name
        browser_assets = [ordered]@{}
        runtime = [ordered]@{
          provider_preference = $providerPreference
          max_context = 2048
        }
      }

      if ($publicBaseUrl) {
        $manifest.browser_assets.onnx = "$publicBaseUrl/$($onnxFile.Name)"
        $manifest.browser_assets.tokenizer = "$publicBaseUrl/$($tokenizerFile.Name)"
        if ($onnxDataFile) {
          $manifest.browser_assets.onnx_data = "$publicBaseUrl/$($onnxDataFile.Name)"
        }
        Write-JsonFile -Path $browserManifestOut -Payload $manifest
      } elseif ($largestFile -le $safeAssetLimit -or $storageMode -eq "workers-static-assets") {
        $modelDestDir = Join-Path $modelDestRoot $currentModelId
        New-Item -ItemType Directory -Path $modelDestDir -Force | Out-Null
        Copy-Item -Path (Join-Path $browserDir "*") -Destination $modelDestDir -Recurse -Force
        $manifest.browser_assets.onnx = "/static/models/$currentModelId/$($onnxFile.Name)"
        $manifest.browser_assets.tokenizer = "/static/models/$currentModelId/$($tokenizerFile.Name)"
        if ($onnxDataFile) {
          $manifest.browser_assets.onnx_data = "/static/models/$currentModelId/$($onnxDataFile.Name)"
        }
        Write-JsonFile -Path $browserManifestOut -Payload $manifest
      }
    }
    }
  }
}

$obsoleteFiles = @(
  "purple-bee-knowledge.bin"
)

foreach ($file in $obsoleteFiles) {
  $target = Join-Path $publicStaticDir $file
  if (Test-Path $target) {
    Remove-Item -Path $target -Force
  }
}

Write-Host "[SYNC] Cloudflare public assets refreshed."
