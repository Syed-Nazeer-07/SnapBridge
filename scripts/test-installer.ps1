$ErrorActionPreference = 'Stop'
$setup = Get-Item 'release/SnapFlow-Setup-*-Windows-x64.exe'
$installPath = Join-Path $env:RUNNER_TEMP 'SnapFlow Installer Test 日本語'
function Run-Setup($file, $arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Installer timed out.' }
  if ($process.ExitCode -ne 0) { throw "Installer returned $($process.ExitCode)." }
}
Run-Setup $setup.FullName "/S /D=$installPath"
$manifestPath = Join-Path $installPath 'resources/native-host/app.snapflow.bridge.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not (Test-Path $manifest.path)) { throw 'Native host manifest path does not resolve.' }
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
    $key = $base.OpenSubKey("Software\$browser\NativeMessagingHosts\app.snapflow.bridge")
    if ($null -eq $key -or $key.GetValue('') -ne $manifestPath) { throw "Native host registration missing for $browser in $view." }
    $key.Dispose()
  }
  $base.Dispose()
}
$desktop = Start-Process -FilePath (Join-Path $installPath 'SnapFlow.exe') -PassThru
try {
  $env:SNAPFLOW_INSTALLED_HOST = $manifest.path
  node scripts/test-installed-native.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Installed native connection failed.' }
  $data = Join-Path $env:APPDATA 'snapflow'
  $marker = Join-Path $data 'installer-retention-check'
  Set-Content $marker 'keep local captures on uninstall'
} finally {
  Get-Process SnapFlow -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $installPath 'SnapFlow.exe') } | Stop-Process -Force
}
Run-Setup (Join-Path $installPath 'Uninstall SnapFlow.exe') '/S'
for ($i=0; $i -lt 100 -and (Test-Path (Join-Path $installPath 'SnapFlow.exe')); $i++) { Start-Sleep -Milliseconds 200 }
if (Test-Path (Join-Path $installPath 'SnapFlow.exe')) { throw 'Uninstall did not remove the executable.' }
if (-not (Test-Path $marker)) { throw 'Uninstall removed user data.' }
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
    $key = $base.OpenSubKey("Software\$browser\NativeMessagingHosts\app.snapflow.bridge")
    if ($null -ne $key) { $key.Dispose(); throw 'Uninstall left native host registration.' }
  }
  $base.Dispose()
}
Write-Output 'PASS installer: install to a path with spaces, Chrome/Edge registration in both registry views, installed desktop/native handshake, uninstall cleanup, and retained user data.'
