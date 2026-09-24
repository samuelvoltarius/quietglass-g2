# Starts each app one at a time in the simulator and captures the glasses
# display. One at a time is deliberate: several simulator instances at once make
# page creation fail as "invalid" and render blank.

$apps = @(
  @{ dir = "promptflow";     port = 5190 },
  @{ dir = "flowlist";       port = 5191 },
  @{ dir = "posture-lens";   port = 5192 },
  @{ dir = "cadence";        port = 5193 },
  @{ dir = "shift-clock";    port = 5194 },
  @{ dir = "decibel-guard";  port = 5195 },
  @{ dir = "status-glass";   port = 5196 },
  @{ dir = "babel-glass";    port = 5197 },
  @{ dir = "field-log";      port = 5198 },
  @{ dir = "openglance-nav"; port = 5199 }
)

$root = "F:\aigner-labs"
$shots = "$root\.verify"
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$automationPort = 9880

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
  $devUp = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $devUp) {
    Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/c", "npm run dev > verify-dev.log 2>&1" -WindowStyle Hidden
    Start-Sleep -Seconds 6
  }

  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", ".\node_modules\.bin\evenhub-simulator.cmd --automation-port $automationPort http://127.0.0.1:$port > verify-sim.log 2>&1" `
    -WindowStyle Normal
  Start-Sleep -Seconds 13

  $result = "NO SIMULATOR"
  $listening = Get-NetTCPConnection -LocalPort $automationPort -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$automationPort/api/screenshot/glasses" `
        -OutFile "$shots\$dir.png" -TimeoutSec 15 -ErrorAction Stop | Out-Null
      $size = (Get-Item "$shots\$dir.png").Length
      $result = "screenshot $size bytes"
    } catch {
      $result = "SCREENSHOT FAILED"
    }
  }

  "{0,-18} {1}" -f $dir, $result

  Get-Process evenhub-simulator -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Set-Location $root
"done"
