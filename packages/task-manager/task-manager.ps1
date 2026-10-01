<#
task-manager: zero-touch bootstrap and repair of one GitHub project per repo, driven by gh.

  double-click task-manager.cmd                    # interactive picker (default)
  pwsh task-manager.ps1                            # same
  pwsh task-manager.ps1 status                     # print every repo's state, no prompt
  pwsh task-manager.ps1 bootstrap -Repo oneezy/tools          # create or repair one repo's project
  pwsh task-manager.ps1 bootstrap -Repo oneezy/tools -NoBrowser   # skip the Auto-add page and its poll
  pwsh task-manager.ps1 roadmap -Repo owner/name -Source path\to\roadmap.md -Plan   # list the phases, write nothing
  pwsh task-manager.ps1 roadmap -Repo owner/name -Source path\to\roadmap.md         # phases as issues + milestones

Picker keys:  up/down move   space toggle   a all/none   enter bootstrap checked   o open project page
              h show/hide archived and forks   r refresh   q quit

Rows are every repo gh can see under $Owners. Each row carries a state:
  no project     the repo is linked to no open project owned by its account
  ok             project, fields, Status options, views, labels and workflows all match the spec below
  needs clicks   everything matches except Auto-add to project, the one browser-only step
  drifted        something else is missing or different; enter repairs it
  login needed   gh holds no token for that account (gh auth login -u <owner> -s project,repo,workflow)

What enter does per repo, in order, each step idempotent:
  project        gh project create (title = repo name), visibility = repo visibility, gh project link
  fields         Priority (single select), Estimate (number), Start and Due (date) via GraphQL
  status         the six options, re-sending existing option ids so item values survive
  views          Backlog (table, sorted by Priority), Board (columns by Status, cards sorted by Priority),
                 Roadmap via the REST create-view endpoint; a view whose sort drifts is recreated,
                 then every view the spec does not name is deleted: the default "View 1" and any
                 made by hand (status reports one as "extra view <name>")
  labels         type and state labels with the decided colours (gh label create --force)
  workflows      "Auto-close issue" deleted (it is on at creation); the five other built-ins are left on
  import         every issue of the repo added to the project
  caller         .github/workflows/task-manager.yml (caller.yml here is the template) put on the repo's
                 dev or default branch through a pull request when it is missing or different; it calls
                 oneezy/tools/.github/workflows/task-manager.yml@main, the workflow itself
  backfill       the caller workflow is dispatched with backfill=true once the file is on that branch
  auto-add       opens <project>/workflows in the browser and polls until "Auto-add to project" is on

What roadmap does (oneezy/tools#77), idempotent by title, -Plan printing without writing:
  reads every "## Phase <n> — <title>" section of the markdown at -Source (a path or URL; the
  "(Milestone ...)" suffix stays in the title; "## Cross-cutting" and the like are not phases) and,
  per phase: an issue titled "Phase <n> — <title>" labelled phase, body = the section's text plus a
  footer naming the source file and commit; a Milestone of the same title (no due date, description
  = the section's first paragraph), which the issue takes; the issue on the repo's project when it is
  missing. Start and Due are never written. Reports created / updated / kept per phase. A task joins
  a phase by taking its Milestone; sub-issues stay wayfinder's.

Facts this relies on, checked 2026-09-22 on a throwaway project (oneezy/tools#16):
  the REST view endpoint takes the login in {user_id} and numeric field ids from GET .../fields,
  sort_by is [[field_id, "desc"]]; deleteProjectV2Workflow on Auto-close removes the row (= off);
  a GraphQL BOARD_LAYOUT view defaults its columns to Status; rewriting Status options with their ids
  keeps "Item added -> Todo" and "Item closed -> Done" working.
#>
param(
  [ValidateSet('menu', 'status', 'bootstrap', 'roadmap')]
  [string]$Action = 'menu',
  [string[]]$Repo = @(),                       # bootstrap/status: owner/name, comma-separated; roadmap: one
  [string[]]$Owners = @('oneezy', 'layerdbiz'),
  [switch]$ShowHidden,                         # include archived repos and forks
  [switch]$NoBrowser,                          # never open the Workflows page or poll for Auto-add
  [int]$PollSeconds = 600,                     # how long to wait for the Auto-add clicks
  [string]$Source,                             # roadmap: path or URL of the roadmap markdown
  [switch]$Plan                                # roadmap: print what would change, write nothing
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false   # gh exit codes are checked by hand in Invoke-Gh
# Phase titles carry em-dashes and bodies carry emoji: gh is spoken to and read back as UTF-8.
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# ---------------------------------------------------------------- spec (from oneezy/tools#7)

$Spec = @{
  Status   = @(
    @{ Name = 'Todo';        Color = 'GRAY';   Description = 'Opened, unassigned' }
    @{ Name = 'Next Up';     Color = 'BLUE';   Description = 'Assigned' }
    @{ Name = 'In Progress'; Color = 'YELLOW'; Description = 'Branch on GitHub' }
    @{ Name = 'Review';      Color = 'ORANGE'; Description = 'Pull request ready for a human' }
    @{ Name = 'Done';        Color = 'GREEN';  Description = 'Merged into dev' }
    @{ Name = 'Complete';    Color = 'PURPLE'; Description = 'Promoted to main' }
  )
  Priority = @(
    @{ Name = 'Low';      Color = 'GREEN';  Description = '' }
    @{ Name = 'Medium';   Color = 'YELLOW'; Description = '' }
    @{ Name = 'High';     Color = 'ORANGE'; Description = '' }
    @{ Name = 'Critical'; Color = 'RED';    Description = '' }
  )
  Fields   = @(
    @{ Name = 'Estimate'; DataType = 'NUMBER' }
    @{ Name = 'Start';    DataType = 'DATE' }
    @{ Name = 'Due';      DataType = 'DATE' }
  )
  Views    = @(
    # The Backlog keeps the wayfinder map: it is the parent row, the tickets nest under it. The Board hides it.
    @{ Name = 'Backlog'; Layout = 'table';   Filter = 'is:open -label:phase'; Sort = 'Priority'; Columns = $null
       Fields = @('Title', 'Status', 'Priority', 'Estimate', 'Labels', 'Assignees', 'Linked pull requests') }
    @{ Name = 'Board';   Layout = 'board';   Filter = '-label:phase -label:"wayfinder:map"'; Sort = 'Priority'; Columns = 'Status'
       Fields = @('Title', 'Priority', 'Estimate', 'Labels', 'Assignees', 'Linked pull requests') }
    @{ Name = 'Roadmap'; Layout = 'roadmap'; Filter = 'label:phase';          Sort = $null;       Columns = $null
       Fields = @() }
  )
  Labels   = @(
    @{ Name = 'bug';           Color = 'd73a4a'; Description = "Something isn't working" }
    @{ Name = 'feature';       Color = '0075ca'; Description = 'New capability' }
    @{ Name = 'tech-debt';     Color = 'ff8c00'; Description = 'Cleanup that pays later' }
    @{ Name = 'question';      Color = 'c2e0c6'; Description = 'Needs an answer before work' }
    @{ Name = 'learning';      Color = 'fbca04'; Description = 'Something to learn' }
    @{ Name = 'reference';     Color = 'd4d4d4'; Description = 'Reference material, not work' }
    @{ Name = 'waiting';       Color = 'fdba74'; Description = 'Waiting on something outside the tickets' }
    @{ Name = 'needs-changes'; Color = 'ff1493'; Description = 'Sent back after Done; returns to In Progress' }
    @{ Name = 'phase';         Color = '1e3a8a'; Description = 'A dated chunk of work; a bar on the roadmap' }
  )
  Workflows = @{
    On  = @('Item added to project', 'Item closed', 'Pull request merged', 'Pull request linked to issue', 'Auto-add sub-issues to project', 'Auto-add to project')
    Off = @('Auto-close issue')
  }
  CallerWorkflow = '.github/workflows/task-manager.yml'
}

$LayoutEnum = @{ table = 'TABLE_LAYOUT'; board = 'BOARD_LAYOUT'; roadmap = 'ROADMAP_LAYOUT' }

# ---------------------------------------------------------------- gh plumbing

$Tokens = @{}

function Get-Token($owner) {
  # gh keeps one token per logged-in account; the owner's token runs every call for that owner so the
  # active account never has to change. An account gh does not know yields $null.
  if ($Tokens.ContainsKey($owner)) { return $Tokens[$owner] }
  $t = & gh auth token -u $owner 2>$null
  $t = if ($LASTEXITCODE -eq 0 -and $t) { [string]$t } else { $null }
  # gh hands back the active account's token when it has none for $owner, so the token is checked
  # against the login it belongs to before it is trusted.
  if ($t) {
    $saved = $env:GH_TOKEN; $env:GH_TOKEN = $t
    try { $login = & gh api user --jq .login 2>$null } finally { $env:GH_TOKEN = $saved }
    if ($login -ne $owner) { $t = $null }
  }
  $Tokens[$owner] = $t
  $t
}

function Invoke-Gh($owner, [string[]]$GhArgs, [string]$Stdin = $null) {
  $saved = $env:GH_TOKEN
  $env:GH_TOKEN = Get-Token $owner
  try {
    $out = if ($null -ne $Stdin) { $Stdin | & gh @GhArgs 2>&1 } else { & gh @GhArgs 2>&1 }
    $text = ($out | ForEach-Object { [string]$_ }) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "gh $($GhArgs -join ' ')`n$text" }
    $text
  } finally { $env:GH_TOKEN = $saved }
}

function Invoke-Graphql($owner, [string]$Query, [hashtable]$Variables = @{}) {
  $body = @{ query = $Query; variables = $Variables } | ConvertTo-Json -Depth 30 -Compress
  $raw = Invoke-Gh $owner @('api', 'graphql', '--input', '-') $body
  $r = $raw | ConvertFrom-Json
  if ($r.errors) { throw "GraphQL: $(($r.errors | ForEach-Object message) -join '; ')" }
  $r.data
}

function Invoke-Rest($owner, [string]$Method, [string]$Path, $Body = $null) {
  $ghArgs = @('api', '-X', $Method, $Path)
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 20 -Compress } else { $null }
  if ($json) { $ghArgs += @('--input', '-') }
  (Invoke-Gh $owner $ghArgs $json) | ConvertFrom-Json
}

# ---------------------------------------------------------------- reading

$ProjectFields = @'
id number title closed public url
repositories(first: 50) { nodes { nameWithOwner } }
fields(first: 40) { nodes {
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color description } } } }
views(first: 20) { nodes { id name number layout filter
  sortByFields(first: 3) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } }
  verticalGroupByFields(first: 3) { nodes { ... on ProjectV2FieldCommon { name } } }
  fields(first: 20) { nodes { ... on ProjectV2FieldCommon { name } } } } }
workflows(first: 20) { nodes { id name number enabled } }
'@

function Get-OwnerProjects($owner) {
  if (-not (Get-Token $owner)) { return @() }
  $q = "query(`$login: String!) { user(login: `$login) { projectsV2(first: 100) { nodes { $ProjectFields } } } }"
  @((Invoke-Graphql $owner $q @{ login = $owner }).user.projectsV2.nodes | Where-Object { -not $_.closed })
}

function Get-Project($owner, [int]$number) {
  $q = "query(`$login: String!, `$n: Int!) { user(login: `$login) { projectV2(number: `$n) { $ProjectFields } } }"
  (Invoke-Graphql $owner $q @{ login = $owner; n = $number }).user.projectV2
}

function Get-Repos($owner) {
  $raw = & gh repo list $owner --limit 500 --json nameWithOwner,name,isArchived,isFork,isPrivate,url,id 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host "  error    gh repo list $owner`: $raw"; return @() }
  @($raw | ConvertFrom-Json)
}

function Get-Labels($owner, $nameWithOwner) {
  $raw = Invoke-Gh $owner @('label', 'list', '-R', $nameWithOwner, '--limit', '200', '--json', 'name,color,description')
  @($raw | ConvertFrom-Json)
}

function Find-Project($repo, $projects) {
  # The repo's project: an open project of the same owner that links this repo; the one titled like
  # the repo wins when several do.
  $linked = @($projects | Where-Object { @($_.repositories.nodes.nameWithOwner) -contains $repo.nameWithOwner })
  if ($linked.Count -eq 0) { return $null }
  $byTitle = $linked | Where-Object { $_.title -eq $repo.name } | Select-Object -First 1
  if ($byTitle) { $byTitle } else { $linked[0] }
}

function Get-Drift($repo, $project, $labels) {
  # Every way the live project differs from $Spec, as short strings. Empty means ok.
  $d = [System.Collections.Generic.List[string]]::new()
  if ($project.public -ne (-not $repo.isPrivate)) { $d.Add('visibility') }

  $status = $project.fields.nodes | Where-Object name -eq 'Status'
  $want = @($Spec.Status | ForEach-Object Name)
  $have = @($status.options | ForEach-Object name)
  if (($have -join '|') -ne ($want -join '|')) { $d.Add('status options') }

  $prio = $project.fields.nodes | Where-Object name -eq 'Priority'
  if (-not $prio) { $d.Add('field Priority') }
  elseif ((@($prio.options | ForEach-Object name) -join '|') -ne (@($Spec.Priority | ForEach-Object Name) -join '|')) { $d.Add('Priority options') }
  foreach ($f in $Spec.Fields) {
    $live = $project.fields.nodes | Where-Object name -eq $f.Name
    if (-not $live) { $d.Add("field $($f.Name)") }
    elseif ($live.dataType -ne $f.DataType) { $d.Add("field $($f.Name) is $($live.dataType)") }
  }

  foreach ($v in $Spec.Views) {
    $live = $project.views.nodes | Where-Object name -eq $v.Name
    if (-not $live) { $d.Add("view $($v.Name)"); continue }
    if ($live.layout -ne $LayoutEnum[$v.Layout]) { $d.Add("view $($v.Name) layout") }
    if ([string]$live.filter -ne $v.Filter) { $d.Add("view $($v.Name) filter") }
    if ($v.Columns -and (@($live.verticalGroupByFields.nodes.name) -join ',') -ne $v.Columns) { $d.Add("view $($v.Name) columns") }
    if ($v.Sort -and (@($live.sortByFields.nodes.field.name) -join ',') -ne $v.Sort) { $d.Add("view $($v.Name) sort") }
  }
  if ($project.views.nodes | Where-Object name -eq 'View 1') { $d.Add('default View 1') }
  foreach ($live in $project.views.nodes) {
    if ($live.name -eq 'View 1' -or $Spec.Views.Name -contains $live.name) { continue }
    $d.Add("extra view $($live.name)")
  }

  foreach ($l in $Spec.Labels) {
    $live = $labels | Where-Object name -eq $l.Name
    if (-not $live) { $d.Add("label $($l.Name)") }
    elseif ($live.color -ne $l.Color) { $d.Add("label $($l.Name) colour") }
  }

  $wf = $project.workflows.nodes
  foreach ($name in $Spec.Workflows.Off) {
    if ($wf | Where-Object { $_.name -eq $name -and $_.enabled }) { $d.Add("workflow $name on") }
  }
  foreach ($name in $Spec.Workflows.On) {
    if (-not ($wf | Where-Object { $_.name -eq $name -and $_.enabled })) { $d.Add("workflow $name off") }
  }
  $d
}

function Get-State($repo, $project, $labels) {
  if (-not (Get-Token $repo.owner)) { return 'login needed' }
  if (-not $project) { return 'no project' }
  $drift = @(Get-Drift $repo $project $labels)
  if ($drift.Count -eq 0) { return 'ok' }
  if ($drift.Count -eq 1 -and $drift[0] -eq 'workflow Auto-add to project off') { return 'needs clicks' }
  'drifted'
}

function Get-Rows([string[]]$OnlyRepos = @()) {
  $only = @($OnlyRepos | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($owner in $Owners) {
    $projects = Get-OwnerProjects $owner
    foreach ($r in Get-Repos $owner) {
      if ($only.Count -and $only -notcontains $r.nameWithOwner) { continue }
      $hidden = $r.isArchived -or $r.isFork
      if ($hidden -and -not $ShowHidden -and -not $only.Count) { continue }
      $r | Add-Member -NotePropertyName owner -NotePropertyValue $owner -Force
      $project = Find-Project $r $projects
      $labels = if ($project) { Get-Labels $owner $r.nameWithOwner } else { @() }
      $state = Get-State $r $project $labels
      $drift = if ($project -and $state -ne 'ok') { @(Get-Drift $r $project $labels) } else { @() }
      [pscustomobject]@{ Repo = $r; Name = $r.nameWithOwner; Owner = $owner; Hidden = $hidden; Project = $project
        State = $state; Drift = $drift; Checked = $false }
    }
  }
}

# ---------------------------------------------------------------- bootstrap steps

function Step($verb, $detail) { Write-Host ("  {0,-11}{1}" -f $verb, $detail) }

function Ensure-Project($row) {
  $repo = $row.Repo; $owner = $row.Owner
  $project = $row.Project
  if (-not $project) {
    $raw = Invoke-Gh $owner @('project', 'create', '--owner', $owner, '--title', $repo.name, '--format', 'json')
    $n = ($raw | ConvertFrom-Json).number
    Step 'created' "project $owner/$n `"$($repo.name)`""
    $project = Get-Project $owner $n
  }
  $wantPublic = -not $repo.isPrivate
  if ($project.public -ne $wantPublic) {
    $vis = if ($wantPublic) { 'PUBLIC' } else { 'PRIVATE' }
    $null = Invoke-Gh $owner @('project', 'edit', $project.number, '--owner', $owner, '--visibility', $vis)
    Step 'set' "visibility $vis (matches the repo)"
  }
  if (@($project.repositories.nodes.nameWithOwner) -notcontains $repo.nameWithOwner) {
    $null = Invoke-Gh $owner @('project', 'link', $project.number, '--owner', $owner, '--repo', $repo.nameWithOwner)
    Step 'linked' $repo.nameWithOwner
  }
  Get-Project $owner $project.number
}

function Ensure-Fields($owner, $project) {
  $prio = $project.fields.nodes | Where-Object name -eq 'Priority'
  $opts = @($Spec.Priority | ForEach-Object { @{ name = $_.Name; color = $_.Color; description = $_.Description } })
  if (-not $prio) {
    $q = 'mutation($p: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]!) { createProjectV2Field(input: { projectId: $p, dataType: SINGLE_SELECT, name: "Priority", singleSelectOptions: $o }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }'
    $null = Invoke-Graphql $owner $q @{ p = $project.id; o = $opts }
    Step 'created' 'field Priority (Low, Medium, High, Critical)'
  } elseif ((@($prio.options.name) -join '|') -ne (@($Spec.Priority.Name) -join '|')) {
    Set-SingleSelect $owner $prio $Spec.Priority
    Step 'rewrote' 'Priority options'
  }
  foreach ($f in $Spec.Fields) {
    $live = $project.fields.nodes | Where-Object name -eq $f.Name
    if ($live) {
      if ($live.dataType -ne $f.DataType) { Step 'left' "field $($f.Name) is $($live.dataType), wanted $($f.DataType); rename it in the browser" }
      continue
    }
    $q = "mutation(`$p: ID!) { createProjectV2Field(input: { projectId: `$p, dataType: $($f.DataType), name: `"$($f.Name)`" }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }"
    $null = Invoke-Graphql $owner $q @{ p = $project.id }
    Step 'created' "field $($f.Name) ($($f.DataType.ToLower()))"
  }
}

function Set-SingleSelect($owner, $field, $wanted) {
  # Re-send every option; an existing option keeps its id so items holding that value are not cleared.
  $opts = @($wanted | ForEach-Object {
    $name = $_.Name
    $o = @{ name = $name; color = $_.Color; description = $_.Description }
    $live = $field.options | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if ($live) { $o.id = $live.id }
    $o
  })
  $q = 'mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]!) { updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }'
  $null = Invoke-Graphql $owner $q @{ f = $field.id; o = $opts }
}

function Ensure-Status($owner, $project) {
  $status = $project.fields.nodes | Where-Object name -eq 'Status'
  if ((@($status.options.name) -join '|') -eq (@($Spec.Status.Name) -join '|')) { return }
  Set-SingleSelect $owner $status $Spec.Status
  Step 'rewrote' "Status: $($Spec.Status.Name -join ', ')"
}

function Ensure-Views($owner, $project) {
  # REST wants the numeric field ids, not node ids; GET .../fields maps names to them.
  $restFields = @(Invoke-Rest $owner 'GET' "users/$owner/projectsV2/$($project.number)/fields")
  $idOf = @{}; foreach ($f in $restFields) { $idOf[$f.name] = $f.id }
  foreach ($v in $Spec.Views) {
    $live = $project.views.nodes | Where-Object name -eq $v.Name
    if ($live -and $v.Sort -and (@($live.sortByFields.nodes.field.name) -join ',') -ne $v.Sort) {
      # No API sets sort on an existing view, so the view is deleted and made again below with it.
      # A view holds no data, only its layout, filter, fields and sort, all of which come from $Spec.
      $null = Invoke-Graphql $owner 'mutation($v: ID!) { deleteProjectV2View(input: { viewId: $v }) { clientMutationId } }' @{ v = $live.id }
      Step 'deleted' "view $($v.Name): sort was not $($v.Sort), recreating it"
      $live = $null
    }
    if ($live) {
      $fix = @{}
      if ($live.layout -ne $LayoutEnum[$v.Layout]) { $fix.layout = $LayoutEnum[$v.Layout] }
      if ([string]$live.filter -ne $v.Filter) { $fix.filter = $v.Filter }
      if ($fix.Count) {
        # filter goes in as a variable: it may hold quotes (-label:"wayfinder:map"); layout is an enum.
        $vars = @{ v = $live.id }
        $set = @()
        if ($fix.layout) { $set += "layout: $($fix.layout)" }
        if ($fix.ContainsKey('filter')) { $set += 'filter: $f'; $vars.f = $fix.filter }
        $q = "mutation(`$v: ID!, `$f: String) { updateProjectV2View(input: { viewId: `$v, $($set -join ', ') }) { projectV2View { id } } }"
        $null = Invoke-Graphql $owner $q $vars
        Step 'fixed' "view $($v.Name) $($fix.Keys -join ', ')"
      }
      continue
    }
    $body = @{ name = $v.Name; layout = $v.Layout; filter = $v.Filter }
    if ($v.Fields.Count) { $body.visible_fields = @($v.Fields | ForEach-Object { $idOf[$_] } | Where-Object { $_ }) }
    if ($v.Columns) { $body.vertical_group_by = @($idOf[$v.Columns]) }
    if ($v.Sort) { $body.sort_by = @(, @($idOf[$v.Sort], 'desc')) }
    $null = Invoke-Rest $owner 'POST' "users/$owner/projectsV2/$($project.number)/views" $body
    Step 'created' "view $($v.Name) ($($v.Layout), $($v.Filter))"
  }
  $fresh = Get-Project $owner $project.number
  $haveAll = -not ($Spec.Views | Where-Object { -not ($fresh.views.nodes | Where-Object name -eq $_.Name) })
  if (-not $haveAll) { return }
  # Every view the spec does not name goes: the default "View 1" and anything made by hand (a project
  # keeps at least one view, which the spec's are). A view holds no data, only how items are shown.
  foreach ($extra in @($fresh.views.nodes | Where-Object { $Spec.Views.Name -notcontains $_.name })) {
    $null = Invoke-Graphql $owner 'mutation($v: ID!) { deleteProjectV2View(input: { viewId: $v }) { clientMutationId } }' @{ v = $extra.id }
    Step 'deleted' $(if ($extra.name -eq 'View 1') { 'default View 1' } else { "view $($extra.name)" })
  }
}

function Ensure-Labels($owner, $repo, $labels) {
  foreach ($l in $Spec.Labels) {
    $live = $labels | Where-Object name -eq $l.Name
    if ($live -and $live.color -eq $l.Color) { continue }
    $null = Invoke-Gh $owner @('label', 'create', $l.Name, '-R', $repo.nameWithOwner, '-c', $l.Color, '-d', $l.Description, '--force')
    Step $(if ($live) { 'recoloured' } else { 'created' }) "label $($l.Name) #$($l.Color)"
  }
}

function Ensure-Workflows($owner, $project) {
  foreach ($name in $Spec.Workflows.Off) {
    $wf = $project.workflows.nodes | Where-Object { $_.name -eq $name -and $_.enabled }
    if (-not $wf) { continue }
    # Deleting a built-in row is how the API turns it off; the Workflows page then shows it as Off.
    $null = Invoke-Graphql $owner 'mutation($w: ID!) { deleteProjectV2Workflow(input: { workflowId: $w }) { deletedWorkflowId } }' @{ w = $wf.id }
    Step 'turned off' "workflow $name"
  }
  foreach ($name in $Spec.Workflows.On | Where-Object { $_ -ne 'Auto-add to project' }) {
    if (-not ($project.workflows.nodes | Where-Object { $_.name -eq $name -and $_.enabled })) {
      Step 'left' "workflow $name is off and has no API; turn it on at $($project.url)/workflows"
    }
  }
}

function Get-Items($owner, $project) {
  # Every item with its Status and, for issues, the state and assignee count the backfill needs.
  $q = 'query($login: String!, $n: Int!, $after: String) { user(login: $login) { projectV2(number: $n) { items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      content { ... on Issue { url state assignees(first: 1) { totalCount } labels(first: 20) { nodes { name } } } ... on PullRequest { url } } } } } } }'
  $after = $null
  do {
    $page = (Invoke-Graphql $owner $q @{ login = $owner; n = $project.number; after = $after }).user.projectV2.items
    foreach ($i in $page.nodes) { $i }
    $after = $page.pageInfo.endCursor
  } while ($page.pageInfo.hasNextPage)
}

function Import-Issues($owner, $repo, $project) {
  $issues = @((Invoke-Gh $owner @('issue', 'list', '-R', $repo.nameWithOwner, '--state', 'all', '--limit', '1000', '--json', 'url')) | ConvertFrom-Json)
  $have = @(Get-Items $owner $project | ForEach-Object { $_.content.url } | Where-Object { $_ })
  $added = 0
  foreach ($i in $issues) {
    if ($have -contains $i.url) { continue }
    $null = Invoke-Gh $owner @('project', 'item-add', $project.number, '--owner', $owner, '--url', $i.url)
    $added++
  }
  Step 'imported' "$added issue(s) added, $($issues.Count - $added) already on the board"
  if ($added) { Start-Sleep -Seconds 6 }   # let the built-in "Item added -> Todo" land before it is corrected

  # Backfill Status from what git already says, the same rules the status workflow applies going
  # forward: closed -> Done (Complete stays Complete: that is the push-to-main promotion, never undone
  # here); open and assigned -> Next Up; open and unassigned -> Todo. Tickets already past Next Up are
  # left where they are. Maps and phases are never moved.
  $status = $project.fields.nodes | Where-Object name -eq 'Status'
  $optId = @{}; foreach ($o in $status.options) { $optId[$o.name] = $o.id }
  $q = 'mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { projectV2Item { id } } }'
  $moved = 0
  foreach ($item in Get-Items $owner $project) {
    if (-not $item.content.state) { continue }   # not an issue
    $now = $item.status.name
    if (@($item.content.labels.nodes.name) -match '^(wayfinder:map|phase)$') { continue }
    $want = if ($item.content.state -eq 'CLOSED') { if ($now -eq 'Complete') { 'Complete' } else { 'Done' } }
            elseif ($now -and $now -notin @('Todo', 'Next Up')) { $now }
            elseif ($item.content.assignees.totalCount -gt 0) { 'Next Up' }
            else { 'Todo' }
    if ($want -eq $now) { continue }
    $null = Invoke-Graphql $owner $q @{ p = $project.id; i = $item.id; f = $status.id; o = $optId[$want] }
    $moved++
  }
  if ($moved) { Step 'backfilled' "Status on $moved item(s) from issue state and assignees" }
}

# The caller file is caller.yml beside this script: a thin workflow that sends the repo's events to
# oneezy/tools/.github/workflows/task-manager.yml@main. A repo whose copy is missing or different
# gets a pull request into its integration branch (dev when it has one, else the default branch);
# nothing is pushed to a branch anyone works on. Issue events only fire once the file is on the
# default branch, which is Justin's promotion, so the step reports the PR and moves on. oneezy/tools
# itself is the host: its file carries the whole workflow, so it is left alone.
function Get-CallerTemplate {
  $file = Join-Path $PSScriptRoot 'caller.yml'
  if (-not (Test-Path $file)) { throw "caller template missing: $file" }
  (Get-Content $file -Raw) -replace "`r`n", "`n"
}

function Get-BranchSha($owner, $nameWithOwner, $branch) {
  try { (Invoke-Rest $owner 'GET' "repos/$nameWithOwner/git/ref/heads/$branch").object.sha } catch { $null }
}

function Ensure-Caller($owner, $repo) {
  $path = $Spec.CallerWorkflow
  $wanted = Get-CallerTemplate
  $name = $repo.nameWithOwner
  $default = (Invoke-Rest $owner 'GET' "repos/$name").default_branch
  $base = if (Get-BranchSha $owner $name 'dev') { 'dev' } else { $default }
  $live = $null
  try { $live = Invoke-Rest $owner 'GET' "repos/$name/contents/${path}?ref=$base" } catch { }
  if ($live) {
    $have = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($live.content -replace '\s', ''))) -replace "`r`n", "`n"
    if ($have -match '(?m)^\s+workflow_call:') { Step 'ok' "$path is the host workflow itself"; return $true }
    if ($have -eq $wanted) { Step 'ok' "$path on $base"; return $true }
  }
  $branch = 'chore/task-manager-caller'
  $open = @((Invoke-Gh $owner @('pr', 'list', '-R', $name, '--head', $branch, '--state', 'open', '--json', 'number,url')) | ConvertFrom-Json)
  if ($open.Count -gt 0) { Step 'waiting' "PR #$($open[0].number) adds $path; merge it, then rerun: $($open[0].url)"; return $false }
  if (-not (Get-BranchSha $owner $name $branch)) {
    $null = Invoke-Rest $owner 'POST' "repos/$name/git/refs" @{ ref = "refs/heads/$branch"; sha = (Get-BranchSha $owner $name $base) }
  }
  $body = @{
    message = "chore(task-manager): $(if ($live) { 'update' } else { 'add' }) the task-manager caller workflow"
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($wanted))
    branch  = $branch
  }
  $onBranch = $null
  try { $onBranch = Invoke-Rest $owner 'GET' "repos/$name/contents/${path}?ref=$branch" } catch { }
  if ($onBranch) { $body.sha = $onBranch.sha }
  $null = Invoke-Rest $owner 'PUT' "repos/$name/contents/$path" $body
  $prBody = "Calls ``oneezy/tools/.github/workflows/task-manager.yml@main`` on issue, branch, pull request and push events, and on ``workflow_dispatch`` for backfill and estimate runs.`n`nNeeds the repo secrets ``PROJECT_PAT`` and ``CLAUDE_CODE_OAUTH_TOKEN``. Written by task-manager (oneezy/tools, ``packages/task-manager``)."
  $url = Invoke-Gh $owner @('pr', 'create', '-R', $name, '--base', $base, '--head', $branch, '--title', "chore(task-manager): add the task-manager caller workflow", '--body', $prBody)
  Step 'opened' "PR adds $path into ${base}: $url"
  $false
}

function Start-Backfill($owner, $repo) {
  $path = $Spec.CallerWorkflow
  $name = $repo.nameWithOwner
  $default = (Invoke-Rest $owner 'GET' "repos/$name").default_branch
  $ref = if (Get-BranchSha $owner $name 'dev') { 'dev' } else { $default }
  $exists = $null
  try { $exists = Invoke-Rest $owner 'GET' "repos/$name/contents/${path}?ref=$ref" } catch { }
  if (-not $exists) { Step 'skipped' "backfill: $path is not on $ref yet"; return }
  $file = Split-Path $path -Leaf
  # GitHub only registers a workflow for dispatch once the file is on the default branch, so a
  # repo whose caller is still on dev reports the dispatch left for after the promotion.
  try {
    $null = Invoke-Gh $owner @('workflow', 'run', $file, '-R', $name, '--ref', $ref, '-f', 'backfill=true')
    Step 'ran' "$file on $ref with backfill=true"
  } catch {
    if ("$_" -match 'not found on the default branch') { Step 'left' "backfill: $file dispatches once it is on $default; promote, then rerun" }
    else { throw }
  }
}

function Wait-AutoAdd($owner, $project, $repo) {
  $on = { param($p) [bool]($p.workflows.nodes | Where-Object { $_.name -eq 'Auto-add to project' -and $_.enabled }) }
  if (& $on $project) { return $true }
  $url = "$($project.url)/workflows"
  if ($NoBrowser) { Step 'left' "Auto-add to project is off: $url"; return $false }
  Step 'opening' $url
  Start-Process $url
  Write-Host ''
  Write-Host '  In the browser: Auto-add to project > Edit > repository ' -NoNewline
  Write-Host $repo.nameWithOwner -NoNewline -ForegroundColor Yellow
  Write-Host ', filter ' -NoNewline
  Write-Host 'is:issue' -NoNewline -ForegroundColor Yellow
  Write-Host ' > Save and turn on workflow.'
  Write-Host "  Waiting up to $PollSeconds s for it to report enabled (s skips)." -ForegroundColor DarkGray
  $deadline = (Get-Date).AddSeconds($PollSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if ([Console]::KeyAvailable -and [Console]::ReadKey($true).Key -eq 'S') { Step 'skipped' 'Auto-add poll'; return $false }
    if (& $on (Get-Project $owner $project.number)) { Step 'verified' 'Auto-add to project is on'; return $true }
  }
  Step 'timed out' 'Auto-add to project still off; rerun when the clicks are done'
  $false
}

function Invoke-Bootstrap($row) {
  Write-Host ''
  Write-Host " $($row.Name)" -ForegroundColor Cyan
  if ($row.State -eq 'login needed') { Step 'skipped' "gh auth login -u $($row.Owner) -s project,repo,workflow first"; return }
  $owner = $row.Owner; $repo = $row.Repo
  try {
    $project = Ensure-Project $row
    Ensure-Fields $owner $project
    Ensure-Status $owner $project
    $project = Get-Project $owner $project.number
    Ensure-Views $owner $project
    Ensure-Labels $owner $repo (Get-Labels $owner $repo.nameWithOwner)
    Ensure-Workflows $owner $project
    Import-Issues $owner $repo $project
    $null = Ensure-Caller $owner $repo
    Start-Backfill $owner $repo
    $project = Get-Project $owner $project.number
    $null = Wait-AutoAdd $owner $project $repo
    $project = Get-Project $owner $project.number
    $drift = @(Get-Drift $repo $project (Get-Labels $owner $repo.nameWithOwner))
    if ($drift.Count -eq 0) { Step 'ok' "$($project.url) matches the spec" }
    else { Step 'remaining' ($drift -join ', ') }
  } catch {
    Step 'error' ($_.Exception.Message -split "`n" | Select-Object -First 3) -join ' '
  }
}

# ---------------------------------------------------------------- roadmap (oneezy/tools#77)

# Phases come from a markdown file: every "## Phase <n> — <title>" section is one issue labelled
# phase and one Milestone of the same title, which the issue takes. A task joins a phase by taking
# that Milestone; sub-issues are wayfinder's and never a phase's. Start and Due stay a human's.

function Format-Text([string]$s) {
  # One shape for comparing text: LF line ends, no trailing spaces, no blank lines at either end.
  if (-not $s) { return '' }
  ((($s -replace "`r`n", "`n") -replace '[ \t]+(\n|$)', '$1')).Trim("`n")
}

function Read-Roadmap([string]$source) {
  # The markdown and where it came from: a URL, or a file with its git commit when it sits in a clone.
  if ($source -match '^https?://') {
    $url = $source -replace '^https://github\.com/([^/]+/[^/]+)/blob/', 'https://raw.githubusercontent.com/$1/'
    return @{ Text = [string](Invoke-WebRequest -Uri $url -UseBasicParsing).Content; Where = $source }
  }
  $path = (Resolve-Path -LiteralPath $source).Path
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  $dir = Split-Path $path
  $prefix = & git -C $dir rev-parse --show-prefix 2>$null
  if ($LASTEXITCODE -ne 0) { return @{ Text = $text; Where = $path } }
  $where = "``$prefix$(Split-Path $path -Leaf)``"
  $commit = & git -C $dir log -1 --format=%h -- $path 2>$null
  if ($commit) { $where += " at ``$commit``" }
  if (& git -C $dir status --porcelain -- $path 2>$null) { $where += ' with uncommitted edits' }
  if ("$(& git -C $dir remote get-url origin 2>$null)" -match 'github\.com[:/]([^/]+/[^/]+?)(\.git)?$') { $where += " in $($Matches[1])" }
  @{ Text = $text; Where = $where }
}

function Get-Phases([string]$text) {
  # Every "## Phase <n> — <title>" section in file order (em-dash, en-dash or hyphen after the number;
  # the title keeps any "(Milestone ...)" suffix): the text under it up to the next "## ", sub-headings
  # included, and that text's first paragraph. Other "## " sections (Cross-cutting, External sources) are skipped.
  $phases = [System.Collections.Generic.List[hashtable]]::new()
  $current = $null
  foreach ($line in (($text -replace "`r`n", "`n") -split "`n")) {
    if ($line -match '^## ') {
      $current = $null
      if ($line -match '^## Phase\s+(\d+)\s+[—–-]\s+(\S.*?)\s*$') {
        $current = @{ Number = [int]$Matches[1]; Title = "Phase $($Matches[1]) $([char]0x2014) $($Matches[2])"; Lines = [System.Collections.Generic.List[string]]::new() }
        $phases.Add($current)
      }
      continue
    }
    if ($current) { $current.Lines.Add($line) }
  }
  foreach ($p in $phases) {
    $p.Text = Format-Text ($p.Lines -join "`n")
    $p.First = ($p.Text -split "`n`n", 2)[0]
    $p.Remove('Lines')
  }
  $phases
}

$FooterMark = "---`nSource: "

function Get-IssueText($body) {
  # The phase text a live issue holds: everything above the footer the command wrote under it.
  $t = Format-Text $body
  $i = $t.LastIndexOf("`n$FooterMark")
  if ($i -ge 0) { $t = $t.Substring(0, $i) }
  Format-Text $t
}

function Invoke-Roadmap([string]$full, [string]$source) {
  if ($full -notmatch '^[^/,]+/[^/,]+$') { Write-Host 'roadmap needs -Repo owner/name (one repo)'; exit 1 }
  if (-not $source) { Write-Host 'roadmap needs -Source <path or URL of the roadmap markdown>'; exit 1 }
  $owner = ($full -split '/')[0]
  if (-not (Get-Token $owner)) { Write-Host "login needed: gh auth login -u $owner -s project,repo,workflow"; exit 1 }
  $md = Read-Roadmap $source
  $phases = @(Get-Phases $md.Text)
  Write-Host ''
  Write-Host " $full  <-  $($md.Where)" -ForegroundColor Cyan
  if ($phases.Count -eq 0) { Step 'error' "no `"## Phase <n> $([char]0x2014) <title>`" section in $source"; exit 1 }
  if ($Plan) { Step 'plan' 'nothing is written; each line says what a real run would do' }
  $footer = "${FooterMark}$($md.Where). Written by task-manager (oneezy/tools, packages/task-manager): edit the roadmap file, not this issue."

  $repo = (Invoke-Gh $owner @('repo', 'view', $full, '--json', 'nameWithOwner,name,isPrivate,isArchived,isFork,url,id')) | ConvertFrom-Json
  $project = Find-Project $repo (Get-OwnerProjects $owner)
  $onBoard = if ($project) { @(Get-Items $owner $project | ForEach-Object { $_.content.url } | Where-Object { $_ }) } else { @() }
  if (-not $project) { Step 'left' "no project is linked to $full; bootstrap it, then rerun to put the phases on the board" }
  $issues = @((Invoke-Gh $owner @('issue', 'list', '-R', $full, '--state', 'all', '--limit', '1000', '--json', 'number,title,body,labels,milestone,id,url')) | ConvertFrom-Json)
  $milestones = @(Invoke-Rest $owner 'GET' "repos/$full/milestones?state=all&per_page=100")
  if (-not (Get-Labels $owner $full | Where-Object name -eq 'phase')) {
    $l = $Spec.Labels | Where-Object Name -eq 'phase'
    if (-not $Plan) { $null = Invoke-Gh $owner @('label', 'create', $l.Name, '-R', $full, '-c', $l.Color, '-d', $l.Description, '--force') }
    Step $(if ($Plan) { 'create' } else { 'created' }) "label phase #$($l.Color)"
  }

  $count = @{ created = 0; updated = 0; kept = 0 }
  $addQ = 'mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }'
  foreach ($p in $phases) {
    $did = [System.Collections.Generic.List[string]]::new()
    $ms = $milestones | Where-Object title -eq $p.Title | Select-Object -First 1
    if (-not $ms) {
      if (-not $Plan) { $ms = Invoke-Rest $owner 'POST' "repos/$full/milestones" @{ title = $p.Title; description = $p.First } }
      $did.Add($(if ($ms) { "milestone #$($ms.number)" } else { 'milestone' }))
    } elseif ((Format-Text $ms.description) -ne $p.First) {
      if (-not $Plan) { $null = Invoke-Rest $owner 'PATCH' "repos/$full/milestones/$($ms.number)" @{ description = $p.First } }
      $did.Add("milestone #$($ms.number) description")
    }

    $issue = $issues | Where-Object title -eq $p.Title | Sort-Object number | Select-Object -First 1
    $body = "$($p.Text)`n`n$footer"
    $new = -not $issue
    if ($new) {
      $in = @{ title = $p.Title; body = $body; labels = @('phase') }
      if ($ms) { $in.milestone = $ms.number }
      if (-not $Plan) {
        $r = Invoke-Rest $owner 'POST' "repos/$full/issues" $in
        $issue = [pscustomobject]@{ number = $r.number; id = $r.node_id; url = $r.html_url }
      }
      $did.Insert(0, $(if ($issue) { "issue #$($issue.number)" } else { 'issue' }))
    } else {
      $patch = @{}
      if ((Get-IssueText $issue.body) -ne $p.Text) { $patch.body = $body; $did.Add("issue #$($issue.number) body") }
      if (@($issue.labels.name) -notcontains 'phase') { $patch.labels = @(@($issue.labels.name) + 'phase'); $did.Add("issue #$($issue.number) label phase") }
      if (-not $issue.milestone -and $ms) { $patch.milestone = $ms.number; $did.Add("issue #$($issue.number) milestone") }
      if ($patch.Count -and -not $Plan) { $null = Invoke-Rest $owner 'PATCH' "repos/$full/issues/$($issue.number)" $patch }
    }

    if ($project -and (-not $issue -or $onBoard -notcontains $issue.url)) {
      if ($issue -and -not $Plan) { $null = Invoke-Graphql $owner $addQ @{ p = $project.id; c = $issue.id } }
      $did.Add('project item')
    }

    $verb = if ($new) { 'created' } elseif ($did.Count) { 'updated' } else { 'kept' }
    $count[$verb]++
    $detail = if ($verb -eq 'kept') { "issue #$($issue.number), milestone #$($ms.number)" } else { $did -join ', ' }
    if ($Plan -and $verb -ne 'kept') { $verb = @{ created = 'create'; updated = 'update' }[$verb] }
    Step $verb "$($p.Title): $detail"
  }
  $sum = "$($phases.Count) phase(s): $($count.created) created, $($count.updated) updated, $($count.kept) kept"
  if ($Plan) { Step 'plan' ($sum -replace 'created', 'to create' -replace 'updated', 'to update') } else { Step 'roadmap' $sum }
}

# ---------------------------------------------------------------- status and picker

function Get-StateColor($state) {
  switch ($state) { 'ok' { 'Green' } 'needs clicks' { 'Yellow' } 'drifted' { 'Red' } 'no project' { 'DarkGray' } default { 'Magenta' } }
}

function Format-Detail($row) {
  switch ($row.State) {
    'ok'           { $row.Project.url }
    'needs clicks' { "$($row.Project.url)/workflows" }
    'drifted'      {
      $head = (@($row.Drift | Select-Object -First 4) -join ', ')
      if ($row.Drift.Count -gt 4) { "$head, +$($row.Drift.Count - 4)" } else { $head }
    }
    'no project'   { if ($row.Hidden) { 'archived or fork' } else { '' } }
    default        { "gh auth login -u $($row.Owner) -s project,repo,workflow" }
  }
}

function Show-Status($rows) {
  foreach ($r in $rows) {
    Write-Host ("  {0,-40} " -f $r.Name) -NoNewline
    Write-Host ("{0,-13}" -f $r.State) -NoNewline -ForegroundColor (Get-StateColor $r.State)
    Write-Host (Format-Detail $r)
  }
}

function Draw-Menu($rows, $cursor, $message) {
  Clear-Host
  Write-Host "Task Manager   one GitHub project per repo   ($($Owners -join ', '))" -ForegroundColor Cyan
  $section = ''
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $rows[$i]
    if ($r.Owner -ne $section) {
      $section = $r.Owner
      Write-Host ''
      Write-Host " $section" -ForegroundColor Cyan
    }
    $ptr = if ($i -eq $cursor) { '>' } else { ' ' }
    $box = if ($r.Checked) { '[x]' } else { '[ ]' }
    $line = ' {0} {1} {2,-36} ' -f $ptr, $box, $r.Repo.name
    if ($i -eq $cursor) { Write-Host $line -NoNewline -ForegroundColor Yellow } else { Write-Host $line -NoNewline }
    Write-Host ("{0,-13}" -f $r.State) -NoNewline -ForegroundColor (Get-StateColor $r.State)
    Write-Host (Format-Detail $r) -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Host ' up/down move   space toggle   a all/none   enter bootstrap checked   o open project   h hidden   r refresh   q quit' -ForegroundColor DarkGray
  if ($message) { Write-Host ''; Write-Host " $message" -ForegroundColor Magenta }
}

function Show-Menu {
  Write-Host 'Reading repos and projects...' -ForegroundColor DarkGray
  $rows = @(Get-Rows)
  if ($rows.Count -eq 0) { Write-Host "No repos found under $($Owners -join ', ')"; return }
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
        'Spacebar'  { $rows[$cursor].Checked = -not $rows[$cursor].Checked }
        'A'         {
          $all = -not ($rows | Where-Object { -not $_.Checked })
          foreach ($r in $rows) { $r.Checked = -not $all }
        }
        'H'         {
          $script:ShowHidden = -not $ShowHidden
          $rows = @(Get-Rows); $cursor = 0
        }
        'R'         {
          $rows = @(Get-Rows)
          if ($cursor -ge $rows.Count) { $cursor = [Math]::Max(0, $rows.Count - 1) }
        }
        'O'         {
          $r = $rows[$cursor]
          if ($r.Project) { Start-Process $r.Project.url } else { $message = "$($r.Name) has no project yet." }
        }
        'Enter'     {
          $picked = @($rows | Where-Object Checked)
          if ($picked.Count -eq 0) { $message = 'Nothing checked. Space toggles a row.'; continue }
          [Console]::CursorVisible = $true
          Write-Host ''
          foreach ($r in $picked) { Invoke-Bootstrap $r }
          Write-Host ''
          Write-Host '  Press any key to go back to the picker.' -ForegroundColor DarkGray
          $null = [Console]::ReadKey($true)
          [Console]::CursorVisible = $false
          $rows = @(Get-Rows)
          if ($cursor -ge $rows.Count) { $cursor = [Math]::Max(0, $rows.Count - 1) }
          $message = "Bootstrapped $($picked.Count) repo(s)."
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
  'menu'      { Show-Menu }
  'status'    { Show-Status @(Get-Rows $Repo) }
  'bootstrap' {
    if ($Repo.Count -eq 0) { Write-Host 'bootstrap needs -Repo owner/name'; exit 1 }
    foreach ($r in @(Get-Rows $Repo)) { Invoke-Bootstrap $r }
  }
  'roadmap'   { Invoke-Roadmap ($Repo -join ',') $Source }
}
