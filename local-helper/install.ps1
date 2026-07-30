# Install Undertwig Local on Windows (one-time). Runs at logon afterwards.
$ErrorActionPreference = "Stop"
$Origin = if ($env:UNDERTWIG_ORIGIN) { $env:UNDERTWIG_ORIGIN } else { "https://www.undertwig.com" }
$Share = Join-Path $env:LOCALAPPDATA "Undertwig"
$Bin = Join-Path $Share "local-console-host.mjs"
$Launcher = Join-Path $Share "start-companion.cmd"
$Startup = [Environment]::GetFolderPath("Startup")
$Shortcut = Join-Path $Startup "Undertwig Local.cmd"

Write-Host "Installing Undertwig Local…"
New-Item -ItemType Directory -Force -Path $Share | Out-Null

$RepoHost = Join-Path (Split-Path -Parent $PSScriptRoot) "local-console-host.mjs"
if (Test-Path $RepoHost) {
  Copy-Item $RepoHost $Bin -Force
} elseif (Test-Path (Join-Path $PSScriptRoot "local-console-host.mjs")) {
  Copy-Item (Join-Path $PSScriptRoot "local-console-host.mjs") $Bin -Force
} else {
  Invoke-WebRequest -Uri "$Origin/local-console-host.mjs" -OutFile $Bin -UseBasicParsing
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  [System.Windows.Forms.MessageBox]::Show(
    "Undertwig Local needs Node.js (free). Install it from https://nodejs.org then run this installer again.",
    "Undertwig Local"
  ) | Out-Null
  Start-Process "https://nodejs.org"
  exit 1
}

$nodePath = $node.Source
@"
@echo off
"$nodePath" "$Bin" serve
"@ | Set-Content -Path $Launcher -Encoding ASCII

Copy-Item $Launcher $Shortcut -Force

# Start now
Start-Process -FilePath $nodePath -ArgumentList @("`"$Bin`"", "serve") -WindowStyle Hidden

Start-Sleep -Milliseconds 700
try {
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:17834/health" -UseBasicParsing
  $msg = "Undertwig Local is installed and running in the background. Return to undertwig.com."
} catch {
  $msg = "Undertwig Local was installed and will start at logon. If needed, run the shortcut in your Startup folder once."
}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($msg, "Undertwig Local") | Out-Null
