Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
foreach ($s in $mgr.GetSessions()) {
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $t = $s.GetTimelineProperties(); $i = $s.GetPlaybackInfo()
  "{0} | {1} | {2} - {3} | album='{4}' | pos={5} end={6} updated={7} | thumb={8}" -f $s.SourceAppUserModelId, $i.PlaybackStatus, $p.Artist, $p.Title, $p.AlbumTitle, $t.Position, $t.EndTime, $t.LastUpdatedTime.ToLocalTime().ToString('HH:mm:ss.fff'), ($p.Thumbnail -ne $null)
}
"now: " + (Get-Date).ToString('HH:mm:ss.fff')
