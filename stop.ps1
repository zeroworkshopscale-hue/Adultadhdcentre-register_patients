# Stops the ADHD Intake App by freeing its ports (closes the hidden servers).
foreach ($p in 8080, 8787) {
  try {
    Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
}
try { (New-Object -ComObject WScript.Shell).Popup("ADHD Intake App stopped.", 4, "ADHD Intake App", 64) | Out-Null } catch {}
