# Sync Justin's skills from the library: one call to the latest published tool (ADR-0008), the skill's words mapped to its commands.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
$ErrorActionPreference = "Stop"
if ($null -eq $Argv) { $Argv = @() }
$first = if ($Argv.Count) { $Argv[0] } else { "" }
$mapped = @(switch ($first) {
  ""       { "--quiet" }
  "add"    { $Argv; "--quiet" }
  default  { $Argv }
})
if ($env:SKILLS_SYNC_CLI) {
  if (-not (Test-Path -LiteralPath $env:SKILLS_SYNC_CLI -PathType Leaf)) { throw "SKILLS_SYNC_CLI is not a built CLI file" }
  node $env:SKILLS_SYNC_CLI @mapped
} else {
  npx --yes '@oneezy/skills-sync@latest' @mapped
}
exit $LASTEXITCODE
