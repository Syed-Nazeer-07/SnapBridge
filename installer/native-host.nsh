!ifndef BUILD_UNINSTALLER
!include "StrFunc.nsh"
${StrRep}
!endif
!include "${BUILD_RESOURCES_DIR}/generated.nsh"

!macro customInstall
  ${StrRep} $0 "$INSTDIR\resources\native-host\SnapFlow.NativeHost.exe" "\" "\\"
  FileOpen $1 "$INSTDIR\resources\native-host\app.snapflow.bridge.json" w
  FileWrite $1 '{$\"name$\":$\"app.snapflow.bridge$\",$\"description$\":$\"SnapFlow browser connection$\",$\"path$\":$\"$0$\",$\"type$\":$\"stdio$\",$\"allowed_origins$\":${SNAPFLOW_ALLOWED_ORIGINS}}'
  FileClose $1
  SetRegView 32
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\app.snapflow.bridge" "" "$INSTDIR\resources\native-host\app.snapflow.bridge.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.snapflow.bridge" "" "$INSTDIR\resources\native-host\app.snapflow.bridge.json"
  SetRegView 64
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\app.snapflow.bridge" "" "$INSTDIR\resources\native-host\app.snapflow.bridge.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.snapflow.bridge" "" "$INSTDIR\resources\native-host\app.snapflow.bridge.json"
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
