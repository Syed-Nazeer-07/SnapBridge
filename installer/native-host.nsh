!macro customInstall
  nsExec::ExecToStack '"$INSTDIR\resources\native-host\SnapFlow.NativeHost.exe" --register'
  Pop $0
  Pop $1
  StrCmp $0 "0" +3
  MessageBox MB_ICONSTOP "SnapFlow could not register its browser connection: $1"
  Abort
!macroend

!macro customUnInstall
  SetRegView 32
  ReadRegStr $0 HKCU "Software\Google\Chrome\NativeMessagingHosts\app.snapflow.bridge" ""
  StrCmp $0 "$INSTDIR\resources\native-host\app.snapflow.bridge.json" 0 +2
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\app.snapflow.bridge"
  ReadRegStr $0 HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.snapflow.bridge" ""
  StrCmp $0 "$INSTDIR\resources\native-host\app.snapflow.bridge.json" 0 +2
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.snapflow.bridge"
  SetRegView 64
  ReadRegStr $0 HKCU "Software\Google\Chrome\NativeMessagingHosts\app.snapflow.bridge" ""
  StrCmp $0 "$INSTDIR\resources\native-host\app.snapflow.bridge.json" 0 +2
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\app.snapflow.bridge"
  ReadRegStr $0 HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.snapflow.bridge" ""
  StrCmp $0 "$INSTDIR\resources\native-host\app.snapflow.bridge.json" 0 +2
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.snapflow.bridge"
!macroend
