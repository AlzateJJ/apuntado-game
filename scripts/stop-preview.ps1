# Stop only the preview process recorded by Codex and its descendants.
$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '..\.local\dev-process.txt'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No hay una vista previa registrada.'; exit 0 }
$previewId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$preview = Get-CimInstance Win32_Process -Filter "ProcessId=$previewId"
if (-not $preview) { Write-Output 'La vista previa ya se detuvo.'; exit 0 }
if ($preview.Name -ne 'node.exe' -or $preview.CommandLine -notmatch 'scripts[/\\]dev\.mjs') {
  throw 'El PID registrado pertenece a otro proceso. No se detuvo nada.'
}
$processes = @(Get-CimInstance Win32_Process)
function Stop-PreviewTree([int]$parentId) {
  foreach ($child in $processes | Where-Object ParentProcessId -EQ $parentId) { Stop-PreviewTree ([int]$child.ProcessId) }
  Stop-Process -Id $parentId -ErrorAction SilentlyContinue
}
Stop-PreviewTree $previewId
Write-Output 'Vista previa detenida. PostgreSQL conserva sus datos y sigue disponible.'
