# Starts the OSCAR backend and the frontend HIDDEN (no console windows) and
# opens the app in the browser. Normally launched by "Start ADHD App.vbs", which
# runs this with no window at all. Feedback is shown via small popups; detailed
# output goes to last-run.log for troubleshooting.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$server = Join-Path $root "server"
$log = Join-Path $root "last-run.log"
"--- run $(Get-Date) ---" | Out-File $log -Encoding utf8

function Show-Note($msg, $icon) {
  try { (New-Object -ComObject WScript.Shell).Popup($msg, 9, "ADHD Intake App", $icon) | Out-Null } catch {}
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Show-Note "Node.js is not installed. I'll open the download page now - install the 'LTS' version, then start the app again." 48
  Start-Process "https://nodejs.org/en/download"
  exit 1
}

# Free the app's ports in case a previous copy is still running.
foreach ($port in 8080, 8787) {
  try {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
}

# Desktop shortcut (points at the hidden VBS launcher), created once.
try {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ADHD Intake App.lnk'
  if (-not (Test-Path $lnk)) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $root 'Start ADHD App.vbs'
    $sc.WorkingDirectory = $root
    $sc.Description = 'ADHD Intake Processing App'
    if (Test-Path (Join-Path $root 'app-icon.ico')) { $sc.IconLocation = Join-Path $root 'app-icon.ico' }
    $sc.Save()
  }
} catch {}

$firstRun = (-not (Test-Path (Join-Path $server "node_modules"))) -or (-not (Test-Path (Join-Path $root "node_modules")))
if ($firstRun) {
  Show-Note "Setting up for the first time. This takes a few minutes - your browser will open automatically when it's ready." 64
}

# Install dependencies if missing (hidden, output captured to the log).
if (-not (Test-Path (Join-Path $server "node_modules"))) {
  Start-Process cmd -ArgumentList "/c npm install >> `"$log`" 2>&1" -WorkingDirectory $server -Wait -WindowStyle Hidden
}
Start-Process cmd -ArgumentList "/c npx playwright install chromium >> `"$log`" 2>&1" -WorkingDirectory $server -Wait -WindowStyle Hidden
if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Start-Process cmd -ArgumentList "/c npm install >> `"$log`" 2>&1" -WorkingDirectory $root -Wait -WindowStyle Hidden
}
if (-not (Test-Path (Join-Path $root ".env"))) {
  Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
}

# Start both servers hidden and detached (node is a console app -> no window).
# The backend's output goes to backend.log so any OSCAR error is recoverable
# even though no window is shown.
$env:PLAYWRIGHT_HEADLESS = "true"
Start-Process node -ArgumentList "--import", "tsx", "src/index.ts" -WorkingDirectory $server -WindowStyle Hidden -RedirectStandardError (Join-Path $root "backend.log") -RedirectStandardOutput (Join-Path $root "backend-info.log")
Start-Process node -ArgumentList "node_modules\vite\bin\vite.js", "dev" -WorkingDirectory $root -WindowStyle Hidden

# Open the app once the frontend has had time to come up.
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 12; Start-Process 'http://localhost:8080'"
