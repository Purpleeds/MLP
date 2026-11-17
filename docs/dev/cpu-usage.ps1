$root = (Get-Process mlp | Select-Object -First 1).Id
$all = Get-CimInstance Win32_Process
$ids = @($root); $added = $true
while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }
$cmd = @{}; foreach ($p in $all) { if ($ids -contains $p.ProcessId) { $t = 'main'; if ($p.CommandLine -match '--type=(\S+)') { $t = $matches[1] }; $cmd[[int]$p.ProcessId] = $t } }
$a = @{}; foreach ($i in $ids) { $q = Get-Process -Id $i -EA SilentlyContinue; if ($q) { $a[$i] = $q.TotalProcessorTime.Ticks } }
Start-Sleep -Seconds 8
$out = foreach ($i in $ids) { $q = Get-Process -Id $i -EA SilentlyContinue; if ($q -and $a[$i] -ne $null) { $pct = ($q.TotalProcessorTime.Ticks - $a[$i]) / 1e7 / 8 * 100; "{0,-14} {1,6:N1}% core" -f $cmd[[int]$i], $pct } }
$out
