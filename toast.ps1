# Windows PowerShell 5.1 supplies the WinRT projection used by DeepSeek Harness.
# Input is a bounded UTF-8 JSON object on the private standard-input pipe.
# Exit 0 means accepted, 2 means Windows disabled notifications, 3 means the
# plugin preference revoked this delivery, and 1 means a transport/WinRT failure.
$ErrorActionPreference = 'Stop'
function Get-ToastContentMode {
  try {
    $path = $env:DSH_NOTIFY_SETTINGS_PATH
    if (-not $path) { return 'disabled' }
    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $path -ErrorAction Stop
    $policy = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
    if ($policy -isnot [pscustomobject] -or $policy.enabled -isnot [bool] -or -not $policy.enabled) { return 'disabled' }
    foreach ($field in 'enabledEpoch', 'previewEpoch') {
      if ($policy.psobject.Properties[$field] -and $policy.$field -isnot [string]) { return 'disabled' }
    }
    if ([string]$policy.enabledEpoch -cne [string]$env:DSH_NOTIFY_ENABLED_EPOCH) { return 'disabled' }
    if ($policy.preview -is [bool] -and $policy.preview -and
        [string]$policy.previewEpoch -ceq [string]$env:DSH_NOTIFY_PREVIEW_EPOCH) { return 'detail' }
    return 'summary'
  } catch [System.Management.Automation.ItemNotFoundException] {
    if ($env:DSH_NOTIFY_SETTINGS_EXISTED -eq '0') { return 'summary' }
    return 'disabled'
  } catch {
    return 'disabled'
  }
}

try {
  $stream = [Console]::OpenStandardInput()
  $buffer = New-Object byte[] 4097
  $length = 0
  while ($length -lt $buffer.Length) {
    $count = $stream.Read($buffer, $length, $buffer.Length - $length)
    if ($count -eq 0) { break }
    $length += $count
  }
  if ($length -eq 0 -or $length -gt 4096) { throw 'Invalid payload length' }
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $payload = ConvertFrom-Json -InputObject $utf8.GetString($buffer, 0, $length)
  if ($payload.title -isnot [string] -or $payload.body -isnot [string] -or $payload.silent -isnot [bool]) {
    throw 'Invalid payload fields'
  }

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $template = @'
<toast><visual><binding template="ToastGeneric"><text>{0}</text><text>{1}</text></binding></visual><audio silent="{2}" /></toast>
'@
  $title = [System.Security.SecurityElement]::Escape($payload.title)
  $body = [System.Security.SecurityElement]::Escape($payload.body)
  $silent = if ($payload.silent) { 'true' } else { 'false' }
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml(($template -f $title, $body, $silent))
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  $summary = $toast
  if ($null -ne $payload.fallbackBody) {
    if ($payload.fallbackBody -isnot [string]) { throw 'Invalid summary' }
    $summaryBody = [System.Security.SecurityElement]::Escape($payload.fallbackBody)
    $summaryDocument = New-Object Windows.Data.Xml.Dom.XmlDocument
    $summaryDocument.LoadXml(($template -f $title, $summaryBody, $silent))
    $summary = New-Object Windows.UI.Notifications.ToastNotification $summaryDocument
  }
  $notifier = $null
  foreach ($appId in 'com.deepseek.dsh', 'electron.app.DeepSeek Harness') {
    try {
      $candidate = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
      # An unregistered shortcut can return an object. Calling the getter
      # explicitly preserves its HRESULT instead of converting the failure to null.
      $setting = $candidate.get_Setting()
      if ($setting.ToString() -ne 'Enabled') { exit 2 }
      $notifier = $candidate
      break
    } catch {
      if ($_.Exception.GetBaseException().HResult -ne [int]0x80070490) { throw }
    }
  }
  if ($null -eq $notifier) { exit 1 }
  switch (Get-ToastContentMode) {
    'detail'  { $notifier.Show($toast) }
    'summary' { $notifier.Show($summary) }
    default   { exit 3 }
  }
  exit 0
}
catch {
  # Parser and WinRT errors may contain fragments of user text.
  exit 1
}
