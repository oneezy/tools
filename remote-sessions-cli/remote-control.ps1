<#
Claude Code Remote Control servers for every project in V:\dev.

  double-click remote-control.cmd            # toggle: starts everything, or stops everything if running
  pwsh V:\dev\remote-control.ps1 start     # start a server for each folder (skips ones already running)
  pwsh V:\dev\remote-control.ps1 stop      # stop every server this script started
  pwsh V:\dev\remote-control.ps1 restart
  pwsh V:\dev\remote-control.ps1 status    # what's running

Folders are discovered automatically (top-level dirs in $Root; names starting
with "." or "_" are skipped). Git repos run in worktree mode so each phone-spawned
session gets its own worktree; non-git folders fall back to same-dir.
Launched at logon by claude-remote-control.cmd in the Startup folder (shell:startup).
#>
param(
  [ValidateSet('toggle', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'toggle',
  [string]$Root = 'V:\dev'
)

$StateFile = Join-Path $Root '.remote-control.json'

function Read-State {
  if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
}
function Write-State($state) { $state | ConvertTo-Json | Set-Content $StateFile }
function Is-Alive($pid_) {
  # "Alive" means the pwsh window we launched still has a claude.exe under it. A window whose
  # claude exited (e.g. workspace-not-trusted) is treated as dead so start/toggle replace it.
  $p = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  if ($null -eq $p -or $p.ProcessName -ne 'pwsh' -or $p.CommandLine -notmatch 'claude remote-control') { return $false }
  $null -ne (Get-CimInstance Win32_Process -Filter "ParentProcessId = $pid_ AND Name = 'claude.exe'")
}
function Any-Running {
  $state = Read-State
  foreach ($v in $state.Values) { if (Is-Alive $v) { return $true } }
  $null -ne (Get-Process pwsh -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.CommandLine -match 'claude remote-control' })
}

function Get-Projects {
  Get-ChildItem -Path $Root -Directory | Where-Object { $_.Name -notmatch '^[._]' }
}

function Start-Servers {
  $state = Read-State
  foreach ($p in Get-Projects) {
    $name = $p.Name
    if ($state[$name] -and (Is-Alive $state[$name])) { Write-Host "  running  $name (pid $($state[$name]))"; continue }
    if ($state[$name]) { Stop-Process -Id $state[$name] -Force -ErrorAction SilentlyContinue }
    $spawn = if (Test-Path (Join-Path $p.FullName '.git')) { 'worktree' } else { 'same-dir' }
    $proc = Start-Process pwsh -WindowStyle Minimized -PassThru -ArgumentList @(
      '-NoExit', '-Command',
      "`$Host.UI.RawUI.WindowTitle = 'claude-rc: $name'; Set-Location '$($p.FullName)'; claude remote-control --name $name --spawn $spawn"
    )
    $state[$name] = $proc.Id
    Write-Host "  started  $name ($spawn, pid $($proc.Id))"
    Start-Sleep -Seconds 2
  }
  Write-State $state
}

function Stop-Servers {
  $state = Read-State
  foreach ($name in @($state.Keys)) {
    $pid_ = $state[$name]
    if (Is-Alive $pid_) {
      # /T kills the pwsh window and the claude process under it
      taskkill /PID $pid_ /T /F *> $null
      Write-Host "  stopped  $name (pid $pid_)"
    } else {
      Write-Host "  gone     $name"
    }
    $state.Remove($name)
  }
  Write-State $state
  # Fallback: servers started by hand (or by an older version of this script) have no pid on file.
  Get-Process pwsh -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -ne $PID -and $_.CommandLine -match 'claude remote-control' } |
    ForEach-Object { taskkill /PID $_.Id /T /F *> $null; Write-Host "  stopped  untracked pwsh (pid $($_.Id))" }
}

function Show-Status {
  $state = Read-State
  foreach ($p in Get-Projects) {
    $pid_ = $state[$p.Name]
    $s = if ($pid_ -and (Is-Alive $pid_)) { "running (pid $pid_)" } else { 'stopped' }
    Write-Host ("  {0,-24} {1}" -f $p.Name, $s)
  }
}

switch ($Action) {
  'toggle'  { if (Any-Running) { Write-Host 'Servers are running - stopping all.'; Stop-Servers } else { Write-Host 'No servers running - starting all.'; Start-Servers } }
  'start'   { Start-Servers }
  'stop'    { Stop-Servers }
  'restart' { Stop-Servers; Start-Sleep -Seconds 1; Start-Servers }
  'status'  { Show-Status }
}
