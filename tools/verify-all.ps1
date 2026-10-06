# Starts each app one at a time in the simulator and captures the glasses
# display. One at a time is deliberate: several simulator instances at once make
# page creation fail as "invalid" and render blank.

$root = "F:\quietglass"

# Every app under apps\ with the dev port from its vite.config, so new apps are
# picked up without editing this list.
$apps = Get-ChildItem "$root\apps" -Directory | ForEach-Object {
  $config = Get-ChildItem $_.FullName -Filter "vite.config.*" | Select-Object -First 1
  if ($config -and ((Get-Content $config.FullName -Raw) -match "port:\s*(\d+)")) {
    @{ dir = $_.Name; port = [int]$Matches[1] }
  }
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

# A capture with no lit pixel means the page never rendered.
function Test-Blank([string]$path) {
  $bitmap = [System.Drawing.Bitmap]::FromFile($path)
  try {
    for ($y = 0; $y -lt $bitmap.Height; $y += 2) {
      for ($x = 0; $x -lt $bitmap.Width; $x += 2) {
        if ($bitmap.GetPixel($x, $y).A -gt 0) { return $false }
      }
    }
    return $true
  } finally { $bitmap.Dispose() }
}

function Get-Capture([string]$dir, [int]$port) {
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", ".\node_modules\.bin\evenhub-simulator.cmd --automation-port $automationPort http://127.0.0.1:$port > verify-sim.log 2>&1" `
    -WindowStyle Normal
  $up = Wait-Until { Get-NetTCPConnection -LocalPort $automationPort -State Listen -ErrorAction SilentlyContinue } 30
  if (-not $up) { return "NO SIMULATOR" }
  Start-Sleep -Seconds 8   # let the app create its page
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$automationPort/api/screenshot/glasses" `
      -OutFile "$shots\$dir.png" -TimeoutSec 15 -ErrorAction Stop | Out-Null
  } catch { return "SCREENSHOT FAILED" }
  finally {
    Get-Process evenhub-simulator -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
  if (Test-Blank "$shots\$dir.png") { return "BLANK" }
  return "screenshot " + (Get-Item "$shots\$dir.png").Length + " bytes"
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
  if (-not (Test-DevServer $port)) {
    Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/c", "npm run dev > verify-dev.log 2>&1" -WindowStyle Hidden
    if (-not (Wait-Until { Test-DevServer $port } 60)) { "{0,-18} {1}" -f $dir, "NO DEV SERVER"; continue }
  }

  $result = Get-Capture $dir $port
  if ($result -eq "BLANK") { $result = Get-Capture $dir $port }   # one retry for a slow first render

  "{0,-18} {1}" -f $dir, $result
}

Set-Location $root
"done"
