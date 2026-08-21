!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.lingstack.browser"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.lingstack.browser"
  Delete "$LOCALAPPDATA\Ling Stack\browser-host\com.lingstack.browser.json"
  RMDir "$LOCALAPPDATA\Ling Stack\browser-host"
!macroend
