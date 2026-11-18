param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$AppId = 'com.deepseek.dsh',
  [switch]$Silent
)

# Raise one Windows toast through the WinRT notification API under the desktop
# shell's own AppUserModelId, so it shows up as "DeepSeek Harness".
# Runs under Windows PowerShell 5.1, which carries the WinRT projections.
#
# Exit codes: 0 shown, 2 notifications disabled for this app or user,
# 1 anything else (the message goes to stderr).
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $template = @'
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>__TITLE__</text>
      <text>__BODY__</text>
    </binding>
  </visual>
  <audio silent="__SILENT__" />
</toast>
'@

  $escape = [System.Security.SecurityElement]
  $xml = $template.Replace('__TITLE__', $escape::Escape($Title)).Replace('__BODY__', $escape::Escape($Body)).Replace('__SILENT__', $(if ($Silent) { 'true' } else { 'false' }))

  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)

  $setting = $notifier.Setting.ToString()
  Write-Output ('setting=' + $setting)
  if ($setting -ne 'Enabled') {
    [Console]::Error.WriteLine('notifications are ' + $setting)
    exit 2
  }

  $notifier.Show($toast)
  exit 0
}
catch {
  [Console]::Error.WriteLine('toast failed: ' + $_.Exception.Message)
  exit 1
}
