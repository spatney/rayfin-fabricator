<#
.SYNOPSIS
  Captures harness screenshots: app components rendered with sample data.

.DESCRIPTION
  Copies harness/docs-harness.{html,tsx} into a checkout's src/renderer (use the same
  clean worktree as launch.ps1, not your working copy), serves it with Vite on a spare
  port, and screenshots each shot with headless Microsoft Edge, once per theme:
  <shot>.png in dark and <shot>.light.png in light. The copied files are removed afterwards.

.EXAMPLE
  ./capture-harness.ps1 -Checkout $env:TEMP\fab-docs\wt -Out $env:TEMP\fab-docs\shots -Shots team-overview,port-conflict
#>
param(
  [Parameter(Mandatory)] [string] $Checkout,
  [Parameter(Mandatory)] [string] $Out,
  [string[]] $Shots = @('team-overview', 'team-publish', 'team-create', 'rayfin-version', 'port-conflict', 'plan', 'skills', 'secrets', 'setup', 'help', 'deploy-progress', 'deploy-error', 'blueprint'),
  [ValidateSet('dark', 'light')] [string[]] $Themes = @('dark', 'light'),
  [int] $Port = 1437,
  [int] $Width = 1440,
  # Window height; 0 uses each shot's own (setup and help are framed in a shorter window).
  [int] $Height = 0,
  [double] $Scale = 1.5
)
$ErrorActionPreference = 'Stop'
$ShotHeights = @{ 'setup' = 760; 'help' = 680 }
$Checkout = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Checkout)
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$renderer = Join-Path $Checkout 'src\renderer'
$html = Join-Path $renderer 'docs-harness.html'
$tsx = Join-Path $renderer 'src\docs-harness.tsx'
Copy-Item (Join-Path $PSScriptRoot 'harness\docs-harness.html') $html -Force
Copy-Item (Join-Path $PSScriptRoot 'harness\docs-harness.tsx') $tsx -Force
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found' }

$vite = Start-Process -FilePath 'npx.cmd' -ArgumentList 'vite', '--port', $Port, '--strictPort' `
  -WorkingDirectory $Checkout -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    try { $ready = (Invoke-WebRequest "http://localhost:$Port/docs-harness.html" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { }
  }
  if (-not $ready) { throw "Vite did not start on port $Port" }

  $profile = Join-Path ([System.IO.Path]::GetTempPath()) "docs-harness-edge-$PID"
  foreach ($shot in $Shots) {
    $h = if ($Height -gt 0) { $Height } elseif ($ShotHeights.ContainsKey($shot)) { $ShotHeights[$shot] } else { 900 }
    foreach ($theme in $Themes) {
      $file = Join-Path $Out ($(if ($theme -eq 'dark') { "$shot.png" } else { "$shot.$theme.png" }))
      & $edge --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$profile" `
        --window-size="$Width,$h" --force-device-scale-factor=$Scale --virtual-time-budget=10000 `
        --screenshot="$file" "http://localhost:$Port/docs-harness.html?shot=$shot&theme=$theme" 2>$null | Out-Null
      Write-Output $file
    }
  }
  Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
} finally {
  # npx starts Vite as a child process: stop the whole tree by process id. Only follow
  # children started after their parent, so a reused process id can't pull in an
  # unrelated process.
  function Stop-Tree([int] $Id, [datetime] $Since) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $Id" |
      Where-Object { $_.CreationDate -ge $Since } |
      ForEach-Object { Stop-Tree $_.ProcessId $_.CreationDate }
    Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
  }
  Stop-Tree $vite.Id $vite.StartTime
  Remove-Item $html, $tsx -Force -ErrorAction SilentlyContinue
}
