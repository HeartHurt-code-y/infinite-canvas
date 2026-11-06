Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
AutoCloseWindow true

!include FileFunc.nsh

!define PRODUCT "无限画布"
!define BINARY "infinite-canvas.exe"
!define INSTALL_KEY "Software\infinitecanvas\${PRODUCT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define LOOK_UP_LOCATION "{installed-online-application}"

Name "${PRODUCT} ${VERSION}"
OutFile "${OUTPUT}"
InstallDir "${LOOK_UP_LOCATION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${PRODUCT} 增量更新"
VIAddVersionKey "CompanyName" "infinitecanvas"
VIAddVersionKey "LegalCopyright" "infinitecanvas"
Page instfiles

Var RegisteredLocation
Var StagedBinary

Function .onInit
  SetRegView 64
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  IfErrors incompatible
  ReadRegStr $RegisteredLocation HKCU "${INSTALL_KEY}" ""
  StrCmp $INSTDIR "${LOOK_UP_LOCATION}" 0 check
  StrCpy $INSTDIR $RegisteredLocation
check:
  StrCmp $INSTDIR "" incompatible
  IfFileExists "$INSTDIR\uninstall.exe" 0 incompatible
  IfFileExists "$INSTDIR\ffmpeg\ffmpeg.exe" 0 incompatible
  IfFileExists "$INSTDIR\ffmpeg\ffprobe.exe" 0 incompatible
  IfFileExists "$INSTDIR\ffmpeg\manifest.json" 0 incompatible
  IfFileExists "$INSTDIR\fonts\liblib-extended\manifest.json" 0 incompatible
  ClearErrors
  GetDLLVersion "$INSTDIR\${BINARY}" $0 $1
  IfErrors incompatible
  IntCmp $0 ${BASE_VERSION_HIGH} 0 incompatible incompatible
  IntCmp $1 ${BASE_VERSION_LOW} ready incompatible incompatible
incompatible:
  MessageBox MB_OK|MB_ICONSTOP "请先安装无限画布 ${BASE_VERSION} 在线版，再从应用内更新。" /SD IDOK
  SetErrorLevel 2
  Abort
ready:
FunctionEnd

Section
  SetOutPath "$INSTDIR"
  ClearErrors
  GetTempFileName $StagedBinary "$INSTDIR"
  IfErrors failed
  File "/oname=$StagedBinary" "${PAYLOAD}"
  IfErrors failed
  StrCpy $1 0
retry:
  ; Stage on the same volume, then atomically replace only the executable.
  System::Call 'kernel32::MoveFileExW(w "$StagedBinary", w "$INSTDIR\${BINARY}", i 9) i.r0'
  StrCmp $0 0 wait
  StrCmp $INSTDIR $RegisteredLocation 0 done
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
done:
  Goto finished
wait:
  IntOp $1 $1 + 1
  IntCmp $1 60 failed
  Sleep 250
  Goto retry
failed:
  Delete "$StagedBinary"
  MessageBox MB_OK|MB_ICONSTOP "更新未完成。请关闭其他无限画布窗口后重新更新。" /SD IDOK
  SetErrorLevel 5
  Abort
finished:
SectionEnd

Function .onInstSuccess
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/R" $R1
  IfErrors finish
  ClearErrors
  ${GetOptions} $R0 "/ARGS" $R1
  IfErrors 0 restart
  StrCpy $R1 ""
restart:
  Exec '"$INSTDIR\${BINARY}" $R1'
finish:
FunctionEnd
