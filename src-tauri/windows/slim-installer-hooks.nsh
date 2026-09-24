; Run the signed new application in a read-only CLI mode before Tauri's
; reinstall page can uninstall a previous MSI installation. The CLI verifies
; all four persistent components against manifests pinned in this executable.
!macro NSIS_HOOK_PREFLIGHT
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=component-check.exe" "${MAINBINARYSRCPATH}"
  ClearErrors
  ExecWait '"$PLUGINSDIR\component-check.exe" --check-runtime-components' $R8
  ${If} ${Errors}
  ${OrIf} $R8 <> 0
    IfSilent +2
    MessageBox MB_ICONSTOP "本机离线资源尚未准备完成。请先打开完整安装的无限画布，等待资源准备完毕，再执行小包更新。"
    SetErrorLevel 43
    Abort
  ${EndIf}
  Delete "$PLUGINSDIR\component-check.exe"
!macroend

; An updater invoked with /UPDATE keeps files omitted by the slim package.
; Explicit uninstall removes only the old app-owned resource directories.
; NSIS RMDir /r follows directory junctions, so walk entries and remove
; reparse points as links instead of recursing into their targets.
Function un.RemoveBundledTreeNoFollow
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  System::Call 'kernel32::GetFileAttributesW(w "$R0")i.R4'
  IntCmp $R4 -1 bundled_done
  IntOp $R4 $R4 & 0x400
  IntCmp $R4 0 bundled_scan bundled_scan bundled_link
bundled_link:
  RMDir "$R0"
  Delete "$R0"
  Goto bundled_done
bundled_scan:
  ClearErrors
  FindFirst $R1 $R2 "$R0\*"
  IfErrors bundled_done
bundled_next:
  StrCmp $R2 "" bundled_close
  StrCmp $R2 "." bundled_advance
  StrCmp $R2 ".." bundled_advance
  StrCpy $R3 "$R0\$R2"
  System::Call 'kernel32::GetFileAttributesW(w "$R3")i.R4'
  IntCmp $R4 -1 bundled_file
  IntOp $R4 $R4 & 0x400
  IntCmp $R4 0 bundled_dir bundled_dir bundled_child_link
bundled_dir:
  IfFileExists "$R3\*.*" 0 bundled_file
  Push $R0
  StrCpy $R0 $R3
  Call un.RemoveBundledTreeNoFollow
  Pop $R0
  RMDir "$R3"
  Goto bundled_advance
bundled_child_link:
  RMDir "$R3"
  Delete "$R3"
  Goto bundled_advance
bundled_file:
  Delete "$R3"
bundled_advance:
  FindNext $R1 $R2
  Goto bundled_next
bundled_close:
  FindClose $R1
  RMDir "$R0"
bundled_done:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
FunctionEnd

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; Custom install paths are allowed. Only clean a directory whose final
    ; segment is this app's product name; otherwise leave unknown files alone.
    StrCpy $R9 "$INSTDIR" "" -5
    ${If} $R9 == "\无限画布"
      ${If} ${FileExists} "$INSTDIR\blender\manifest.json"
        StrCpy $R0 "$INSTDIR\blender"
        Call un.RemoveBundledTreeNoFollow
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\remotion-runtime\runtime-manifest.json"
        StrCpy $R0 "$INSTDIR\remotion-runtime"
        Call un.RemoveBundledTreeNoFollow
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\ffmpeg\manifest.json"
        StrCpy $R0 "$INSTDIR\ffmpeg"
        Call un.RemoveBundledTreeNoFollow
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\skills\anime-drama-v23\manifest.json"
        StrCpy $R0 "$INSTDIR\skills"
        Call un.RemoveBundledTreeNoFollow
      ${EndIf}
      RMDir "$INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend
