# Programa en el Programador de tareas de Windows (manual de operación §4):
#   - respaldo diario de MySQL a las 23:45 (después del resumen diario de las 23:00);
#   - prueba de restauración cada domingo a las 03:00.
# Ejecutar UNA vez en PowerShell como administrador:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\registrar-tareas.ps1
# Para quitarlas: Unregister-ScheduledTask -TaskName 'Ventas - *' -Confirm:$false
$ErrorActionPreference = 'Stop'
$raiz = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$npm = (Get-Command npm.cmd).Source
$logs = Join-Path $raiz 'apps\api\storage\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Registrar($nombre, $script, $disparador) {
  $accion = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $raiz `
    -Argument "/c `"$npm`" run $script -w @sv/api >> `"$logs\$script.log`" 2>&1"
  $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparador -Settings $ajustes `
    -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Write-Host "Tarea registrada: $nombre"
}

Registrar 'Ventas - respaldo diario' 'respaldo' (New-ScheduledTaskTrigger -Daily -At '23:45')
Registrar 'Ventas - prueba de restauración' 'respaldo:probar' (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '03:00')
