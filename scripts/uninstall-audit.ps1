<#
.SYNOPSIS
  Snapshot the machine before and after installing MultiZone, and diff.

.DESCRIPTION
  The 1.0.0 "clean uninstall — no orphaned files or registry entries" item has
  never been checked; the answer is currently unknown rather than believed-good.
  This makes it a diff.

  Run it in a Windows Sandbox or a VM snapshot, never on a machine you use — the
  point is a clean baseline, and an existing MultiZone install poisons it.

  Three phases:

    .\uninstall-audit.ps1 -Phase before     # then install, launch, use it
    .\uninstall-audit.ps1 -Phase after      # then uninstall from Add/Remove
    .\uninstall-audit.ps1 -Phase diff

  Phase 'diff' prints what the install added and what survived the uninstall.
  Every survivor is then a decision rather than a discovery: the SQLite database
  and the checkpoint blob store arguably *should* survive (they are the user's
  data, and NSIS ought to be asking), while registry entries, the WebView2
  user-data folder and anything under Program Files must not.

.PARAMETER Phase
  before | after | diff

.PARAMETER Path
  Where to keep the snapshots. Defaults to the current directory.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("before", "after", "diff")]
  [string]$Phase,

  [string]$Path = "."
)

$ErrorActionPreference = "Stop"

# The places a Tauri app on Windows can plausibly leave something. Kept
# explicit rather than scanning the whole disk: a full-disk diff on a VM is
# minutes of noise from Windows itself, and every one of these is a place we
# know the app or its installer writes.
$FileRoots = @(
  "$env:APPDATA",
  "$env:LOCALAPPDATA",
  "${env:ProgramFiles}",
  "${env:ProgramFiles(x86)}",
  "$env:PROGRAMDATA"
)

$RegistryRoots = @(
  "HKCU:\Software",
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
)

# Depth 3 keeps the snapshot to seconds rather than minutes while still reaching
# `AppData\Roaming\com.multizone.desktop\<file>`, which is where the database is.
$Depth = 3

function Get-FileSnapshot {
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($root in $FileRoots) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    Write-Host "  scanning $root"
    try {
      Get-ChildItem -LiteralPath $root -Recurse -Depth $Depth -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $items.Add($_.FullName) }
    } catch {
      Write-Warning "  skipped $root : $($_.Exception.Message)"
    }
  }
  return $items
}

function Get-RegistrySnapshot {
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($root in $RegistryRoots) {
    if (-not (Test-Path $root)) { continue }
    Write-Host "  scanning $root"
    try {
      Get-ChildItem -LiteralPath $root -Recurse -Depth $Depth -ErrorAction SilentlyContinue |
        ForEach-Object { $items.Add($_.Name) }
    } catch {
      Write-Warning "  skipped $root : $($_.Exception.Message)"
    }
  }
  return $items
}

function Save-Snapshot([string]$name) {
  Write-Host "Snapshotting files…"
  $files = Get-FileSnapshot
  Write-Host "Snapshotting registry…"
  $reg = Get-RegistrySnapshot

  $files | Set-Content -LiteralPath (Join-Path $Path "$name-files.txt") -Encoding utf8
  $reg   | Set-Content -LiteralPath (Join-Path $Path "$name-registry.txt") -Encoding utf8

  Write-Host ""
  Write-Host "$name : $($files.Count) paths, $($reg.Count) registry keys"
}

# Anything whose name mentions the app. What the diff is looking for is a
# survivor with our name on it; a Windows temp file that appeared in between is
# noise, and this is what separates them.
function Test-IsOurs([string]$s) {
  return $s -match "multizone|com\.multizone\.desktop"
}

switch ($Phase) {
  "before" {
    Write-Host "Phase 1 of 3 — baseline. Do not install MultiZone yet." -ForegroundColor Cyan
    Save-Snapshot "before"
    Write-Host ""
    Write-Host "Next: install MultiZone, launch it, and use it enough to write data —" -ForegroundColor Yellow
    Write-Host "  a chat, a zone, a knowledge base, a checkpoint (edit a file via a tool)," -ForegroundColor Yellow
    Write-Host "  and let it download an update if one is offered. Then run: -Phase after" -ForegroundColor Yellow
  }

  "after" {
    if (-not (Test-Path (Join-Path $Path "before-files.txt"))) {
      throw "No baseline found. Run -Phase before first."
    }
    Write-Host "Phase 2 of 3 — installed state." -ForegroundColor Cyan
    Save-Snapshot "after"
    Write-Host ""
    Write-Host "Next: uninstall MultiZone from Settings > Apps, then run: -Phase diff" -ForegroundColor Yellow
  }

  "diff" {
    foreach ($n in @("before", "after")) {
      if (-not (Test-Path (Join-Path $Path "$n-files.txt"))) { throw "Missing $n snapshot." }
    }
    Write-Host "Phase 3 of 3 — post-uninstall diff." -ForegroundColor Cyan
    Save-Snapshot "final"

    $before = @{}
    Get-Content (Join-Path $Path "before-files.txt")   | ForEach-Object { $before[$_] = $true }
    Get-Content (Join-Path $Path "before-registry.txt") | ForEach-Object { $before[$_] = $true }

    $installed = @(Get-Content (Join-Path $Path "after-files.txt")) + @(Get-Content (Join-Path $Path "after-registry.txt"))
    $final     = @{}
    (@(Get-Content (Join-Path $Path "final-files.txt")) + @(Get-Content (Join-Path $Path "final-registry.txt"))) |
      ForEach-Object { $final[$_] = $true }

    $added    = $installed | Where-Object { -not $before.ContainsKey($_) }
    $survived = $added     | Where-Object { $final.ContainsKey($_) }

    $addedOurs    = $added    | Where-Object { Test-IsOurs $_ }
    $survivedOurs = $survived | Where-Object { Test-IsOurs $_ }

    Write-Host ""
    Write-Host "The install added $($added.Count) paths/keys, $($addedOurs.Count) of them named for MultiZone."
    Write-Host ""

    if ($survivedOurs.Count -eq 0) {
      Write-Host "Nothing named for MultiZone survived the uninstall." -ForegroundColor Green
    } else {
      Write-Host "SURVIVED THE UNINSTALL ($($survivedOurs.Count)):" -ForegroundColor Yellow
      $survivedOurs | Sort-Object | ForEach-Object { Write-Host "  $_" }
      Write-Host ""
      Write-Host "Each of these is now a decision:" -ForegroundColor Cyan
      Write-Host "  - the SQLite database and checkpoint blobs are the user's data; NSIS should ask"
      Write-Host "  - registry keys, the WebView2 user-data folder, and anything under Program Files must not survive"
    }

    $survivedOurs | Sort-Object | Set-Content -LiteralPath (Join-Path $Path "survived.txt") -Encoding utf8
    Write-Host ""
    Write-Host "Full list written to survived.txt"
  }
}
