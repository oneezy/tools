# Git worktree provisioning. This module never removes worktrees, deletes branches,
# resets a checkout, stashes changes, pushes, or asks Claude to own a worktree.
function Invoke-TaskGit([string]$Directory, [string[]]$Arguments, [switch]$AllowFailure) {
    $output=@(& git -C $Directory @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $code=$LASTEXITCODE
    if($code -ne 0 -and !$AllowFailure){throw "Git failed in '$Directory': $($output -join ' ')"}
    [pscustomobject]@{Code=$code;Text=($output -join "`n")}
}
function Get-TaskWorktrees([string]$ProjectDirectory) {
    $text=(Invoke-TaskGit $ProjectDirectory @('-c','core.quotePath=false','worktree','list','--porcelain')).Text
    foreach($block in ($text -split '(?:\r?\n){2,}')) {
        $path=$null; $branch=$null; $prunable=$false
        foreach($line in ($block -split '\r?\n')) {
            if($line.StartsWith('worktree ')){$path=$line.Substring(9)}
            if($line.StartsWith('branch refs/heads/')){$branch=$line.Substring(18)}
            if($line.StartsWith('prunable')){$prunable=$true}
        }
        if($path){[pscustomobject]@{Path=(Normalize-Path $path);Branch=$branch;Prunable=$prunable}}
    }
}
function Get-TaskWorktreePlan([string]$ProjectDirectory, [string]$TaskName, [string]$RequestedBranch, [string]$PreferredDirectory, [string]$Identity) {
    $top=(Invoke-TaskGit $ProjectDirectory @('rev-parse','--show-toplevel')).Text
    if(!(Same-Path $top $ProjectDirectory)){throw "'$ProjectDirectory' must be the root of its own Git repository."}
    $trees=@(Get-TaskWorktrees $ProjectDirectory)
    $branch=$RequestedBranch
    if(!$branch -and $PreferredDirectory){$branch=($trees | Where-Object {Same-Path $_.Path $PreferredDirectory} | Select-Object -First 1).Branch}
    if($branch -in @('main','dev')){throw 'Choose a task branch, not main or dev.'}
    if($branch -and (Invoke-TaskGit $ProjectDirectory @('check-ref-format','--branch',$branch) -AllowFailure).Code -ne 0){throw "Invalid task branch '$branch'."}
    $existing=@($trees | Where-Object {$branch -and $_.Branch -eq $branch})
    $usable=@($existing | Where-Object {!$_.Prunable -and (Test-Path -LiteralPath (Join-Path $_.Path '.git'))})
    if($usable.Count){
        if(Same-Path $usable[0].Path $ProjectDirectory){throw "Task branch '$branch' is checked out in the main project folder. Switch that folder to dev before assigning this branch to a parallel task."}
        return [pscustomobject]@{ProjectDirectory=$ProjectDirectory;WorkingDirectory=$usable[0].Path;Branch=$branch;Operation='reuse';Base=$null}
    }
    $branchExists=$branch -and (Invoke-TaskGit $ProjectDirectory @('show-ref','--verify','--quiet',"refs/heads/$branch") -AllowFailure).Code -eq 0
    $slug=($TaskName -replace '[^a-zA-Z0-9._-]+','-').Trim('.','-')
    if(!$slug){$slug='task'}
    if($slug.Length -gt 48){$slug=$slug.Substring(0,48)}
    $suffix=$Identity.Substring(0,8)
    $directory=Join-Path $ProjectDirectory ".claude/worktrees/$slug-$suffix"
    while(Test-Path -LiteralPath $directory){$directory=Join-Path $ProjectDirectory ".claude/worktrees/$slug-$([guid]::NewGuid().ToString('N').Substring(0,8))"}
    if($branchExists -and !$existing.Count){
        # Git can restore an existing branch without touching its commits.
        if($PreferredDirectory -and !(Test-Path -LiteralPath $PreferredDirectory) -and
            ([IO.Path]::GetFullPath($PreferredDirectory).StartsWith((Join-Path $ProjectDirectory '.claude/worktrees') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))){$directory=$PreferredDirectory}
        return [pscustomobject]@{ProjectDirectory=$ProjectDirectory;WorkingDirectory=$directory;Branch=$branch;Operation='restore';Base=$branch}
    }
    # A stale registration can reserve an old branch. Preserve it and use a fresh
    # branch instead of --force, pruning registrations, or deleting anything.
    if(!$branch -or $branchExists){$branch="codex/$slug-$suffix"}
    while((Invoke-TaskGit $ProjectDirectory @('show-ref','--verify','--quiet',"refs/heads/$branch") -AllowFailure).Code -eq 0){$branch="codex/$slug-$([guid]::NewGuid().ToString('N').Substring(0,8))"}
    $remoteBranch=$RequestedBranch -and !$branchExists -and (Invoke-TaskGit $ProjectDirectory @('show-ref','--verify','--quiet',"refs/remotes/origin/$RequestedBranch") -AllowFailure).Code -eq 0
    [pscustomobject]@{ProjectDirectory=$ProjectDirectory;WorkingDirectory=$directory;Branch=$branch;Operation='create';Base=$(if($remoteBranch){"origin/$RequestedBranch"}else{'dev'});RequestedBranch=$RequestedBranch}
}
function New-TaskWorktree($Workspace) {
    if($Workspace.Operation -eq 'reuse'){return}
    $project=$Workspace.ProjectDirectory
    if($Workspace.Operation -eq 'create'){
        $hasOrigin=(Invoke-TaskGit $project @('remote','get-url','origin') -AllowFailure).Code -eq 0
        if($hasOrigin){$null=Invoke-TaskGit $project @('fetch','origin')}
        if($Workspace.RequestedBranch -and $Workspace.Branch -eq $Workspace.RequestedBranch -and
            (Invoke-TaskGit $project @('show-ref','--verify','--quiet',"refs/remotes/origin/$($Workspace.RequestedBranch)") -AllowFailure).Code -eq 0){
            $null=Invoke-TaskGit $project @('worktree','add','-b',$Workspace.Branch,$Workspace.WorkingDirectory,"origin/$($Workspace.RequestedBranch)")
            return
        }
        $hasDev=(Invoke-TaskGit $project @('show-ref','--verify','--quiet','refs/heads/dev') -AllowFailure).Code -eq 0
        $hasRemoteDev=(Invoke-TaskGit $project @('show-ref','--verify','--quiet','refs/remotes/origin/dev') -AllowFailure).Code -eq 0
        if(!$hasDev){
            # Bootstrap dev for a newly-created repository without checking out or
            # changing main. Task branches are still always cut from dev.
            $base=if($hasRemoteDev){'origin/dev'}else{'HEAD'}
            if((Invoke-TaskGit $project @('rev-parse','--verify',$base) -AllowFailure).Code -ne 0){throw "'$project' needs its first commit before Git can create a worktree."}
            $null=Invoke-TaskGit $project @('branch','dev',$base)
        } elseif($hasRemoteDev) {
            $local=(Invoke-TaskGit $project @('rev-parse','dev')).Text
            $remote=(Invoke-TaskGit $project @('rev-parse','origin/dev')).Text
            if($local -ne $remote -and (Invoke-TaskGit $project @('merge-base','--is-ancestor','origin/dev','dev') -AllowFailure).Code -ne 0){
                if((Invoke-TaskGit $project @('merge-base','--is-ancestor','dev','origin/dev') -AllowFailure).Code -ne 0){throw 'Local dev has diverged from origin/dev; preserve that work and reconcile it before creating a task.'}
                $devTree=@(Get-TaskWorktrees $project | Where-Object Branch -EQ 'dev')
                if($devTree.Count){
                    if((Invoke-TaskGit $devTree[0].Path @('status','--porcelain')).Text){throw 'The dev checkout has uncommitted changes; cannot fast-forward it safely.'}
                    $null=Invoke-TaskGit $devTree[0].Path @('merge','--ff-only','origin/dev')
                } else {$null=Invoke-TaskGit $project @('update-ref','refs/heads/dev',$remote,$local)}
            }
        }
        $null=Invoke-TaskGit $project @('worktree','add','-b',$Workspace.Branch,$Workspace.WorkingDirectory,'dev')
    } else {$null=Invoke-TaskGit $project @('worktree','add',$Workspace.WorkingDirectory,$Workspace.Branch)}
}
