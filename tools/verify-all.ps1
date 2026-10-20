# Starts each app one at a time in the simulator and captures the glasses
# display. One at a time is deliberate: several simulator instances at once make
# page creation fail as "invalid" and render blank.

param(
  [switch]$StoreEnglish,
  [string[]]$Include = @(),
  # Store screenshots in this language (en/de). With -Tap a second picture is
  # taken after one tap (apps whose start list leads into the cockpit).
  [string]$Lang = "en",
  [switch]$Tap
)

$root = "F:\quietglass"

# Every app under apps\ with the dev port from its vite.config, so new apps are
# picked up without editing this list.
$apps = Get-ChildItem "$root\apps" -Directory | ForEach-Object {
  $config = Get-ChildItem $_.FullName -Filter "vite.config.*" | Select-Object -First 1
  if ($config -and ((Get-Content $config.FullName -Raw) -match "port:\s*(\d+)")) {
    @{ dir = $_.Name; port = [int]$Matches[1] }
  }
} | Where-Object {
  $_.dir -ne "node_modules" -and
  ($Include.Count -eq 0 -or $Include -contains $_.dir) -and
  (-not $StoreEnglish -or $_.dir -ne "klipper-glance")
}

$shots = "$root\.verify"
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$automationPort = 9880
Add-Type -AssemblyName System.Drawing

# Polls until the condition holds or the timeout passes. Fixed sleeps were too
# short right after a dependency upgrade, when Vite re-optimizes on first start.
function Wait-Until([scriptblock]$condition, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Test-DevServer([int]$port) {
  try { (Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

# A capture with no lit pixel means the page never rendered. The simulator uses
# transparent pixels for the dark lens area and alpha for illuminated pixels.
function Test-Blank([string]$path) {
  $bitmap = [System.Drawing.Bitmap]::FromFile($path)
  try {
    $maxAlpha = 0
    for ($y = 0; $y -lt $bitmap.Height; $y += 2) {
      for ($x = 0; $x -lt $bitmap.Width; $x += 2) {
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.A -gt $maxAlpha) { $maxAlpha = $pixel.A }
      }
    }
    return $maxAlpha -lt 8
  } finally { $bitmap.Dispose() }
}

# English store pictures keep the old name (release\<app>\screenshot.png) that
# the listings point to; other languages get a suffix.
function Get-CapturePath([string]$dir, [string]$suffix) {
  if ($StoreEnglish) {
    $name = if ($Lang -eq "en") { "screenshot$suffix.png" } else { "screenshot-$Lang$suffix.png" }
    return "$root\release\$dir\$name"
  }
  return "$shots\$dir-$Lang$suffix.png"
}

function Get-Capture([string]$dir, [int]$port) {
  # A fragment keeps the locale override separate without relying on cmd.exe's
  # special handling of `&` in URLs. Apps ignore `demo=1` when no demo is needed.
  $url = "http://127.0.0.1:$port/?demo=1#lang=$Lang"
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", ".\node_modules\.bin\evenhub-simulator.cmd --automation-port $automationPort `"$url`" > verify-sim.log 2>&1" `
    -WindowStyle Hidden
  $up = Wait-Until { Get-NetTCPConnection -LocalPort $automationPort -State Listen -ErrorAction SilentlyContinue } 30
  if (-not $up) { return "NO SIMULATOR" }
  Start-Sleep -Seconds 8   # let the app create its page
  try {
    $capture = Get-CapturePath $dir ""
    New-Item -ItemType Directory -Force -Path (Split-Path $capture) | Out-Null
    Invoke-WebRequest -Uri "http://127.0.0.1:$automationPort/api/screenshot/glasses" `
      -OutFile $capture -TimeoutSec 15 -ErrorAction Stop | Out-Null
    if ($Tap) {
      Invoke-WebRequest -Uri "http://127.0.0.1:$automationPort/api/input" -Method Post -ContentType "application/json" `
        -Body '{"action":"click"}' -TimeoutSec 10 -UseBasicParsing | Out-Null
      Start-Sleep -Seconds 5   # page rebuild + cockpit tiles
      Invoke-WebRequest -Uri "http://127.0.0.1:$automationPort/api/screenshot/glasses" `
        -OutFile (Get-CapturePath $dir "-tap") -TimeoutSec 15 -ErrorAction Stop | Out-Null
    }
  } catch { return "SCREENSHOT FAILED" }
  finally {
    Get-Process evenhub-simulator -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
  $capture = Get-CapturePath $dir ""
  if (Test-Blank $capture) { return "BLANK" }
  return "screenshot " + (Get-Item $capture).Length + " bytes"
}

# Clear anything left over from earlier runs.
Get-Process evenhub-simulator -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*node*" } | Out-Null
Start-Sleep -Seconds 2

foreach ($app in $apps) {
  $dir = $app.dir
  $port = $app.port
  Set-Location "$root\apps\$dir"

  # Only start a dev server if that port is not already serving.
  $started = $false
  if (-not (Test-DevServer $port)) {
    Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/c", "npm run dev > verify-dev.log 2>&1" -WindowStyle Hidden
    $started = $true
    if (-not (Wait-Until { Test-DevServer $port } 60)) { "{0,-18} {1}" -f $dir, "NO DEV SERVER" }
  }

  if (Test-DevServer $port) {
    $result = Get-Capture $dir $port
    if ($result -eq "BLANK") { $result = Get-Capture $dir $port }   # one retry for a slow first render
    "{0,-18} {1}" -f $dir, $result
  }

  # Stop the dev server this script started; one left running per app locks
  # the folders (moving an app failed with "Permission denied").
  if ($started) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
}

Set-Location $root
"done"
