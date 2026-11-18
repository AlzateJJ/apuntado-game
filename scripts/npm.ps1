# Use Node 24 without replacing the user's system-wide Node installation.
$ErrorActionPreference = 'Stop'
$systemNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$nodeExecutable = $systemNode
if (-not $nodeExecutable -or (& $nodeExecutable -p 'process.versions.node.split(".")[0]') -ne '24') {
  $bundled = $env:APUNTADO_NODE24
  $localConfig = Join-Path $PSScriptRoot '..\.local\node-path.txt'
  if (-not $bundled -and (Test-Path -LiteralPath $localConfig)) { $bundled = (Get-Content -LiteralPath $localConfig -Raw).Trim() }
  if (-not $bundled -or (& $bundled -p 'process.versions.node.split(".")[0]') -ne '24') { throw 'Instala Node.js 24 LTS y vuelve a ejecutar este comando.' }
  $nodeExecutable = $bundled
}
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmCli = Join-Path (Split-Path $npmCommand) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw 'No se encontró npm-cli.js. Instala Node.js 24 con npm.' }
$originalPath = $env:PATH
try { $env:PATH = (Split-Path $nodeExecutable) + ';' + $env:PATH; & $nodeExecutable $npmCli @args; $result = $LASTEXITCODE }
finally { $env:PATH = $originalPath }
exit $result
