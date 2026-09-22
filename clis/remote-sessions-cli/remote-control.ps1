<#
Claude Code Remote Control launcher for the projects in V:\dev. One window controls every server,
and shows everything else on this machine that a phone can reach.

  double-click remote-control.cmd          # interactive picker (default)
  pwsh remote-control.ps1                  # same
  pwsh remote-control.ps1 start            # start every folder, no prompt
  pwsh remote-control.ps1 start -Only tools,tridentcubed   # start just those folders (also works from a phone session)
  pwsh remote-control.ps1 stop             # stop every server this script started
  pwsh remote-control.ps1 stop -Only tools # stop just those
  pwsh remote-control.ps1 status           # print what's running

Picker keys:  up/down move   space toggle   a all/none   enter start checked   x stop checked
              l open log for the highlighted row   r refresh   q quit (servers keep running)

Section 1, projects: top-level dirs in $Root (names starting with "." or "_" are skipped). Enter starts a
hidden `claude remote-control --spawn worktree` per checked folder; output goes to $Root\.remote-control\<name>.log.
Before a server starts, the folder is marked trusted in ~/.claude.json so claude never stops on the
"Workspace not trusted" dialog.

Section 2, other bridged sessions: anything else on this machine that claude.ai / the phone can talk to,
found from ~/.claude/sessions (VS Code and terminal sessions) and ~/.claude/projects/*/bridge-pointer.json
(remote-control servers started by hand), on Windows and in every WSL distro. `x` ends them too.

Section 3, Codex: one server for the whole machine, not per folder. The CLI daemon row starts/stops with
`codex remote-control start|stop` (enter / x) and `p` prints a manual pairing code for the phone. The
ChatGPT desktop app's own server is reported only; it is paired inside that app
(Settings > Connections > Control this PC).
#>
param(
  [ValidateSet('menu', 'start', 'stop', 'status')]
  [string]$Action = 'menu',
  [string]$Root = 'V:\dev',
  [string[]]$Only = @()      # start/stop: limit to these folder names (comma-separated)
)

$StateFile  = Join-Path $Root '.remote-control.json'
$LogDir     = Join-Path $Root '.remote-control'
$ClaudeHome = Join-Path $HOME '.claude'
$ClaudeJson = Join-Path $HOME '.claude.json'
$Spawn      = 'worktree'
$LogLines   = 40   # rolling window kept per server log

function Read-State {
  if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
}
function Write-State($state) { $state | ConvertTo-Json | Set-Content $StateFile }
function Is-Alive($pid_) {
  # "Alive" means the hidden pwsh we launched still has a claude.exe under it. A pwsh whose
  # claude exited is treated as dead so a start replaces it.
  if (-not $pid_) { return $false }
  $p = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  if ($null -eq $p -or $p.ProcessName -ne 'pwsh' -or $p.CommandLine -notmatch 'claude remote-control') { return $false }
  $null -ne (Get-CimInstance Win32_Process -Filter "ParentProcessId = $pid_ AND Name = 'claude.exe'")
}

function Get-Projects {
  Get-ChildItem -Path $Root -Directory | Where-Object { $_.Name -notmatch '^[._]' } | Sort-Object Name
}

function Get-Selected {
  # Projects named in -Only, or all of them when -Only is empty. Unknown names are reported, not ignored.
  $all = @(Get-Projects)
  if ($Only.Count -eq 0) { return $all }
  $names = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($n in $names) { if (-not ($all | Where-Object Name -eq $n)) { Write-Host "  unknown  $n (not a folder in $Root)" } }
  @($all | Where-Object { $names -contains $_.Name })
}

function Log-Path($name) { Join-Path $LogDir "$name.log" }

function Ensure-Trusted($path) {
  # claude keys ~/.claude.json "projects" by absolute path; it has been seen with both slash styles.
  if (-not (Test-Path $ClaudeJson)) { return }
  $cfg = Get-Content $ClaudeJson -Raw | ConvertFrom-Json -AsHashtable
  if (-not $cfg.ContainsKey('projects')) { $cfg['projects'] = @{} }
  $changed = $false
  foreach ($key in @($path, ($path -replace '\\', '/'))) {
    if (-not $cfg.projects.ContainsKey($key)) { $cfg.projects[$key] = @{}; $changed = $true }
    if ($cfg.projects[$key]['hasTrustDialogAccepted'] -ne $true) { $cfg.projects[$key]['hasTrustDialogAccepted'] = $true; $changed = $true }
  }
  if ($changed) {
    Copy-Item $ClaudeJson "$ClaudeJson.bak" -Force
    $cfg | ConvertTo-Json -Depth 100 | Set-Content $ClaudeJson -Encoding utf8
    Write-Host "  trusted  $path"
  }
}

function Start-Project($p, $state) {
  $name = $p.Name
  if (Is-Alive $state[$name]) { Write-Host "  running  $name (pid $($state[$name]))"; return }
  if ($state[$name]) { Stop-Process -Id $state[$name] -Force -ErrorAction SilentlyContinue }
  Ensure-Trusted $p.FullName
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $log = Log-Path $name
  Remove-Item $log, "$log.err" -Force -ErrorAction SilentlyContinue
  # claude redraws its screen constantly when stdout is not a terminal, so a plain redirect grows
  # by ~1 MB/hour. The wrapper keeps a rolling window of the last $LogLines lines instead.
  $wrapper = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    "`$q = [Collections.Generic.Queue[string]]::new(); " +
    "claude remote-control --name $name --spawn $Spawn 2>&1 | ForEach-Object { " +
    "`$q.Enqueue([string]`$_); while (`$q.Count -gt $LogLines) { `$null = `$q.Dequeue() }; " +
    "[IO.File]::WriteAllLines('$log', `$q) }"
  $proc = Start-Process pwsh -WindowStyle Hidden -PassThru `
    -WorkingDirectory $p.FullName `
    -ArgumentList @('-NoProfile', '-Command', $wrapper)
  $state[$name] = $proc.Id
  Write-Host "  started  $name ($Spawn, pid $($proc.Id))"
  Start-Sleep -Seconds 2
}

function Stop-Project($name, $state) {
  $pid_ = $state[$name]
  if (Is-Alive $pid_) {
    taskkill /PID $pid_ /T /F *> $null   # /T kills the pwsh and the claude process under it
    Write-Host "  stopped  $name (pid $pid_)"
  } elseif ($pid_) {
    Write-Host "  gone     $name"
  }
  $state.Remove($name)
}

function Start-All {
  $state = Read-State
  foreach ($p in Get-Selected) { Start-Project $p $state }
  Write-State $state
}

function Stop-All {
  $state = Read-State
  $names = if ($Only.Count) { @(Get-Selected | ForEach-Object Name) } else { @($state.Keys) }
  foreach ($name in $names) { Stop-Project $name $state }
  Write-State $state
  if ($Only.Count) { return }
  # Fallback: servers started by hand have no pid on file.
  Get-Process pwsh -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -ne $PID -and $_.CommandLine -match 'claude remote-control' } |
    ForEach-Object { taskkill /PID $_.Id /T /F *> $null; Write-Host "  stopped  untracked pwsh (pid $($_.Id))" }
}

function Get-LogSummary($name) {
  # Last known state from the server's own output: "connected, N/32 sessions", "connecting", or its error.
  $log = Log-Path $name
  if (-not (Test-Path $log)) { return '' }
  $tail = Get-Content $log -Tail 12 -ErrorAction SilentlyContinue
  if (-not $tail) { return '' }
  $text = ($tail -join "`n") -replace "`e\[[0-9;]*[A-Za-z]", ''
  if ($text -match '(?m)^\s*(Error: .*)$') { return $Matches[1].Trim() }
  $cap = if ($text -match 'Capacity: (\d+)/(\d+)') { "$($Matches[1])/$($Matches[2]) sessions" } else { '' }
  $conn = if ($text -match 'Connected') { 'connected' } elseif ($text -match 'Connecting') { 'connecting' } else { '' }
  (@($conn, $cap) | Where-Object { $_ }) -join ', '
}

# ---------------------------------------------------------------- other bridged sessions

function Get-OurClaudePids($state) {
  # claude.exe children of the pwsh wrappers this script launched.
  $pids = @{}
  foreach ($pid_ in $state.Values) {
    if (-not $pid_) { continue }
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $pid_ AND Name = 'claude.exe'" -ErrorAction SilentlyContinue |
      ForEach-Object { $pids[[int]$_.ProcessId] = $true }
  }
  $pids
}

function Get-WindowsBridged($ours) {
  $procs = @{}
  Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { $procs[[int]$_.ProcessId] = $_ }

  # 1. Interactive sessions bridged to claude.ai (VS Code extension, terminals).
  Get-ChildItem (Join-Path $ClaudeHome 'sessions') -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    try { $s = Get-Content $_.FullName -Raw | ConvertFrom-Json } catch { return }
    if (-not $s.pid -or -not $s.bridgeSessionId) { return }
    $proc = $procs[[int]$s.pid]
    if (-not $proc) { return }
    # Sessions spawned by a remote-control server belong to that server's row, skip them.
    $parent = $procs[[int]$proc.ParentProcessId]
    if ($parent -and $parent.CommandLine -match ' (remote-control|rc)( |$)') { return }
    $where = switch ($s.entrypoint) { 'claude-vscode' { 'VS Code' } 'sdk-cli' { 'SDK' } default { 'terminal' } }
    [pscustomobject]@{ Kind = 'session'; Host = 'windows'; Pid = [int]$s.pid; Name = "$where  $($s.cwd)";
      Summary = "session $($s.name), $($s.status)"; Checked = $false }
  }

  # 2. remote-control servers not started by this script (e.g. `claude rc` typed in a terminal).
  Get-ChildItem (Join-Path $ClaudeHome 'projects') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $f = Join-Path $_.FullName 'bridge-pointer.json'
    if (-not (Test-Path $f)) { return }
    try { $b = Get-Content $f -Raw | ConvertFrom-Json } catch { return }
    if (-not $b.pid -or $ours.ContainsKey([int]$b.pid)) { return }
    $proc = $procs[[int]$b.pid]
    if (-not $proc -or $proc.CommandLine -notmatch ' (remote-control|rc)( |$)') { return }
    $label = if ($proc.CommandLine -match '--name (\S+)') { $Matches[1] } else { $_.Name }
    [pscustomobject]@{ Kind = 'session'; Host = 'windows'; Pid = [int]$b.pid; Name = "hand-started server  $label";
      Summary = "folder $($_.Name)"; Checked = $false }
  }
}

$WslScan = @'
for f in "$HOME"/.claude/sessions/*.json; do
  [ -f "$f" ] || continue
  pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f")
  kill -0 "$pid" 2>/dev/null || continue
  bridge=$(sed -n 's/.*"bridgeSessionId":"\([^"]*\)".*/\1/p' "$f")
  [ -n "$bridge" ] || continue
  echo "S|$pid|$(sed -n 's/.*"entrypoint":"\([^"]*\)".*/\1/p' "$f")|$(sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' "$f")"
done
for f in "$HOME"/.claude/projects/*/bridge-pointer.json; do
  [ -f "$f" ] || continue
  pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f")
  kill -0 "$pid" 2>/dev/null || continue
  echo "B|$pid|$(basename "$(dirname "$f")")"
done
'@

function Get-WslDistros {
  if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { return @() }
  @(wsl -l -q 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -and $_ -ne 'docker-desktop' })
}

function Get-WslBridged {
  foreach ($d in Get-WslDistros) {
    $lines = $WslScan | wsl -d $d -- sh 2>$null
    foreach ($line in @($lines)) {
      $f = $line -split '\|'
      switch ($f[0]) {
        'S' { [pscustomobject]@{ Kind = 'session'; Host = $d; Pid = [int]$f[1]; Name = "WSL $d  $($f[3])"; Summary = "$($f[2]) session"; Checked = $false } }
        'B' { [pscustomobject]@{ Kind = 'session'; Host = $d; Pid = [int]$f[1]; Name = "WSL $d  hand-started server"; Summary = "folder $($f[2])"; Checked = $false } }
      }
    }
  }
}

function Stop-Session($row) {
  if ($row.Host -eq 'windows') { taskkill /PID $row.Pid /T /F *> $null }
  else { wsl -d $row.Host -- kill $row.Pid 2>$null }
  Write-Host "  ended    $($row.Name) (pid $($row.Pid))"
}

# ---------------------------------------------------------------- Codex
# Codex remote is one server for the whole machine, not one per folder. Two things can provide it:
#   - the ChatGPT desktop app's own app-server (up whenever that app is open; paired in the app under
#     Settings > Connections > Control this PC). Reported only.
#   - the CLI daemon: `codex remote-control start|stop|pair`. Needs a one-time
#     `codex app-server daemon enable-remote-control`; the start handler does that when codex asks for it.

function Get-CodexServers {
  $parents = @{}
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $parents[[int]$_.ProcessId] = $_.Name }
  Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match ' app-server' } |
    ForEach-Object {
      $parent = $parents[[int]$_.ParentProcessId]
      $owner = if ($_.CommandLine -match '\.vscode') { 'vscode' }
               elseif ($parent -match '^(ChatGPT|Codex)') { 'desktop' }
               else { 'daemon' }
      [pscustomobject]@{ Pid = [int]$_.ProcessId; Owner = $owner; Parent = $parent }
    }
}

function Get-CodexRows {
  $servers = @(Get-CodexServers)
  $daemon = $servers | Where-Object Owner -eq 'daemon' | Select-Object -First 1
  $desktop = $servers | Where-Object Owner -eq 'desktop' | Select-Object -First 1
  [pscustomobject]@{ Kind = 'codex'; Name = 'Codex CLI remote-control daemon'; Alive = [bool]$daemon;
    Pid = $(if ($daemon) { $daemon.Pid }); Summary = $(if ($daemon) { 'whole machine reachable' } else { '' }); Checked = $false }
  [pscustomobject]@{ Kind = 'codexinfo'; Name = 'Codex via ChatGPT desktop app'; Alive = [bool]$desktop;
    Pid = $(if ($desktop) { $desktop.Pid }); Summary = $(if ($desktop) { 'paired in the app: Settings > Connections > Control this PC' } else { 'open the ChatGPT app to use this route' }); Checked = $false }
}

function Invoke-Codex([string[]]$CodexArgs) {
  $out = & codex @CodexArgs 2>&1 | ForEach-Object { [string]$_ }
  (($out -join ' ') -replace '\s+', ' ').Trim()
}

function Start-CodexDaemon {
  $r = Invoke-Codex @('remote-control', 'start')
  if ($r -match 'enable remote control|no transport|remote control is (not|dis)') {
    Write-Host '  codex    enabling remote control for the CLI daemon (one-time)'
    $null = Invoke-Codex @('app-server', 'daemon', 'enable-remote-control')
    $r = Invoke-Codex @('remote-control', 'start')
  }
  if ($r -match 'Job Object') { $r = 'codex refused to detach from this console. Run `codex remote-control start` in a plain Windows Terminal once.' }
  Write-Host "  codex    $r"
  $r
}

function Stop-CodexDaemon {
  $r = Invoke-Codex @('remote-control', 'stop')
  Write-Host "  codex    $r"
  $r
}

function Get-CodexPairCode { Invoke-Codex @('remote-control', 'pair') }

function Show-Status {
  $state = Read-State
  foreach ($p in Get-Projects) {
    $pid_ = $state[$p.Name]
    $s = if (Is-Alive $pid_) { "running (pid $pid_)  $(Get-LogSummary $p.Name)" } else { 'stopped' }
    Write-Host ("  {0,-24} {1}" -f $p.Name, $s)
  }
  $others = @(Get-WindowsBridged (Get-OurClaudePids $state)) + @(Get-WslBridged)
  if ($others.Count) {
    Write-Host ''; Write-Host '  Other Claude sessions reachable from your phone:'
    foreach ($o in $others) { Write-Host ("  {0,-48} pid {1}  {2}" -f $o.Name, $o.Pid, $o.Summary) }
  }
  Write-Host ''
  foreach ($c in Get-CodexRows) {
    $s = if ($c.Alive) { "running (pid $($c.Pid))  $($c.Summary)" } else { "stopped  $($c.Summary)" }
    Write-Host ("  {0,-34} {1}" -f $c.Name, $s)
  }
}

# ---------------------------------------------------------------- interactive picker

function Get-Rows {
  # A dead pid on file means the server died since we last looked: report its last words once,
  # then forget the pid so the next refresh shows a plain "stopped".
  $state = Read-State
  $dirty = $false
  foreach ($p in Get-Projects) {
    $pid_ = $state[$p.Name]
    $alive = Is-Alive $pid_
    $summary = if ($pid_) { Get-LogSummary $p.Name } else { '' }
    if ($pid_ -and -not $alive) { $state.Remove($p.Name); $dirty = $true }
    [pscustomobject]@{ Kind = 'project'; Project = $p; Name = $p.Name; Alive = $alive; Pid = $pid_; Summary = $summary; Checked = $false }
  }
  if ($dirty) { Write-State $state }
  Get-WindowsBridged (Get-OurClaudePids $state)
  Get-WslBridged
  Get-CodexRows
}

$SectionTitles = @{
  project   = " Claude Code, one server per folder (spawn: $Spawn, hidden, logs in $LogDir):"
  session   = ' Other Claude sessions reachable from your phone (not started here; x ends them):'
  codex     = ' Codex, one server for the whole machine (enter start, x stop, p pairing code):'
}

function Draw-Menu($rows, $cursor, $message) {
  Clear-Host
  Write-Host "Remote Control   $Root" -ForegroundColor Cyan
  $section = ''
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $rows[$i]
    $kind = if ($r.Kind -eq 'codexinfo') { 'codex' } else { $r.Kind }
    if ($kind -ne $section) {
      $section = $kind
      Write-Host ''
      Write-Host $SectionTitles[$section] -ForegroundColor Cyan
    }
    $ptr = if ($i -eq $cursor) { '>' } else { ' ' }
    $box = if ($r.Kind -eq 'codexinfo') { '   ' } elseif ($r.Checked) { '[x]' } else { '[ ]' }
    switch ($r.Kind) {
      'project' {
        if ($r.Alive) {
          $status = "running (pid $($r.Pid))"; $color = 'Green'
          if ($r.Summary) { $status += "  $($r.Summary)" }
        } else {
          $status = 'stopped'; $color = 'DarkGray'
          # A dead server with an error on file: show why it died.
          if ($r.Summary -and $r.Summary -notmatch '^connect') { $status += "  $($r.Summary)"; $color = 'Red' }
        }
        $line = ' {0} {1} {2,-34} ' -f $ptr, $box, $r.Name
      }
      'session' {
        $status = "pid $($r.Pid)  $($r.Summary)"; $color = 'Yellow'
        $line = ' {0} {1} {2,-48} ' -f $ptr, $box, $r.Name
      }
      default {
        if ($r.Alive) { $status = "running (pid $($r.Pid))  $($r.Summary)"; $color = 'Green' }
        else { $status = "stopped  $($r.Summary)"; $color = 'DarkGray' }
        $line = ' {0} {1} {2,-34} ' -f $ptr, $box, $r.Name
      }
    }
    if ($i -eq $cursor) { Write-Host $line -NoNewline -ForegroundColor Yellow } else { Write-Host $line -NoNewline }
    Write-Host $status -ForegroundColor $color
  }
  Write-Host ''
  Write-Host ' up/down move   space toggle   a all/none   enter start checked   x stop checked   p codex pair   l log   r refresh   q quit' -ForegroundColor DarkGray
  if ($message) { Write-Host ''; Write-Host " $message" -ForegroundColor Magenta }
}

function Show-Menu {
  $rows = @(Get-Rows)
  if ($rows.Count -eq 0) { Write-Host "No project folders found in $Root"; return }
  $cursor = 0
  $message = ''
  [Console]::CursorVisible = $false
  try {
    while ($true) {
      Draw-Menu $rows $cursor $message
      $message = ''
      $key = [Console]::ReadKey($true)
      switch ($key.Key) {
        'UpArrow'   { $cursor = ($cursor - 1 + $rows.Count) % $rows.Count }
        'DownArrow' { $cursor = ($cursor + 1) % $rows.Count }
        'K'         { $cursor = ($cursor - 1 + $rows.Count) % $rows.Count }
        'J'         { $cursor = ($cursor + 1) % $rows.Count }
        'Spacebar'  {
          if ($rows[$cursor].Kind -eq 'codexinfo') { $message = 'The ChatGPT desktop app manages that one itself.'; continue }
          $rows[$cursor].Checked = -not $rows[$cursor].Checked
        }
        'A'         {
          $projects = @($rows | Where-Object Kind -eq 'project')
          $all = -not ($projects | Where-Object { -not $_.Checked })
          foreach ($r in $projects) { $r.Checked = -not $all }
        }
        'R'         {
          $rows = @(Get-Rows)
          if ($cursor -ge $rows.Count) { $cursor = [Math]::Max(0, $rows.Count - 1) }
        }
        'L'         {
          if ($rows[$cursor].Kind -ne 'project') { $message = 'Only launcher-started Claude servers have a log here.'; continue }
          $log = Log-Path $rows[$cursor].Name
          if (Test-Path $log) { Start-Process notepad $log } else { $message = "No log yet for $($rows[$cursor].Name)." }
        }
        'P'         {
          Write-Host ''; Write-Host '  codex    requesting a pairing code...'
          $code = Get-CodexPairCode
          $message = "Codex pairing: $code   (phone: ChatGPT app > Codex > Pair manually)"
        }
        'Enter'     {
          $projects = @($rows | Where-Object { $_.Checked -and $_.Kind -eq 'project' })
          $codex = @($rows | Where-Object { $_.Checked -and $_.Kind -eq 'codex' })
          $skipped = @($rows | Where-Object { $_.Checked -and $_.Kind -eq 'session' }).Count
          if ($projects.Count -eq 0 -and $codex.Count -eq 0) { $message = 'Nothing startable checked. Space toggles a row.'; continue }
          Write-Host ''
          $notes = @()
          if ($projects.Count) {
            $state = Read-State
            foreach ($r in $projects) { Start-Project $r.Project $state }
            Write-State $state
            $notes += "Started $($projects.Count) Claude server(s)."
          }
          if ($codex.Count) {
            if ($codex[0].Alive) { $notes += 'Codex daemon already running.' } else { $notes += "Codex: $(Start-CodexDaemon)" }
          }
          if ($skipped) { $notes += "Skipped $skipped session(s): those can only be stopped." }
          Start-Sleep -Seconds 3   # let the servers write "Connected" before the logs are read
          $rows = @(Get-Rows)
          $message = $notes -join '  '
        }
        'X'         {
          $picked = @($rows | Where-Object Checked)
          if ($picked.Count -eq 0) { $message = 'Nothing checked. Space toggles a row.'; continue }
          Write-Host ''
          $state = Read-State
          $notes = @()
          foreach ($r in $picked) {
            switch ($r.Kind) {
              'project' { Stop-Project $r.Name $state }
              'session' { Stop-Session $r }
              'codex'   { $notes += "Codex: $(Stop-CodexDaemon)" }
            }
          }
          Write-State $state
          Start-Sleep -Seconds 1
          $rows = @(Get-Rows)
          if ($cursor -ge $rows.Count) { $cursor = [Math]::Max(0, $rows.Count - 1) }
          $message = (@("Stopped $($picked.Count) item(s).") + $notes) -join '  '
        }
        'Q'         { return }
        'Escape'    { return }
      }
    }
  } finally {
    [Console]::CursorVisible = $true
  }
}

switch ($Action) {
  'menu'   { Show-Menu }
  'start'  { Start-All }
  'stop'   { Stop-All }
  'status' { Show-Status }
}
