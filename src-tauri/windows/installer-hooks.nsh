; Fabricator's hooks for Tauri's NSIS installer (bundle > windows > nsis > installerHooks).
;
; Fabricator runs rayfin-local, the sidecar installed next to it, as a child process for each
; open project. Windows can't replace or delete a running .exe, so the installer and the
; uninstaller stop the sidecar before they touch its file. They stop only the processes running
; this installation's $INSTDIR\rayfin-local.exe, never every process with that name: a user may
; run their own rayfin-local.

!include "LogicLib.nsh"
!include "Win\RestartManager.nsh"

!define /ifndef ERROR_MORE_DATA 234

; An in-app update starts this installer with /UPDATE and then exits Fabricator, which can still be
; on its way out when the running-app check below runs. That check asks the Restart Manager to shut
; down everything that uses Fabricator's executable, and stops the update with "Failed to kill Rayfin
; Fabricator" when anything can't be: the exiting app, the system processes that hold an executable
; while a process ends, a virus scanner reading it (tauri-apps/tauri#16277). So an update first
; waits, at most 20 seconds by the clock, until nothing uses Fabricator's or the sidecar's
; executable. Whatever still uses them after that is closed as before, and listed in the details.
!macro RAYFIN_FABRICATOR_WAIT_FOR_EXIT
  ${If} $UpdateMode = 1
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    Push $R9
    StrCpy $R9 0
    System::Call 'kernel32::GetTickCount() i .R7'
    ${Do}
      StrCpy $0 0
      !insertmacro RestartManager_StartSession $R8
      ${If} $R8 != ""
        !insertmacro RestartManager_RegisterFile $R8 "$INSTDIR\${MAINBINARYNAME}.exe"
        ${If} $0 = 0
        ${AndIf} ${FileExists} "$INSTDIR\rayfin-local.exe"
          !insertmacro RestartManager_RegisterFile $R8 "$INSTDIR\rayfin-local.exe"
        ${EndIf}
        ${If} $0 = 0
          ; ERROR_MORE_DATA: something still uses them.
          System::Call 'RSTRTMGR::RmGetList(i R8, *i .r1, *i .r2, p 0, *i .r3) i .r0'
        ${EndIf}
        System::Call 'kernel32::GetTickCount() i .r1'
        IntOp $1 $1 - $R7
        ${If} $0 = ${ERROR_MORE_DATA}
        ${AndIf} $1 >= 20000
          ; RM_PROCESS_INFO is 668 bytes, with the process id at 0 and strAppName[256] at 12.
          DetailPrint "Still in use after 20 seconds by:"
          System::Alloc 6680
          Pop $R6
          StrCpy $2 10
          System::Call 'RSTRTMGR::RmGetList(i R8, *i .r1, *i r2r2, p R6, *i .r3) i .r0'
          ${IfThen} $0 <> 0 ${|} StrCpy $2 0 ${|}
          StrCpy $R5 0
          ${DoWhile} $R5 < $2
            IntOp $R4 $R5 * 668
            IntOp $R4 $R4 + $R6
            System::Call '*$R4(i .r4)'
            IntOp $R4 $R4 + 12
            System::Call '*$R4(&w256 .r5)'
            DetailPrint "  $5 (process $4)"
            IntOp $R5 $R5 + 1
          ${Loop}
          System::Free $R6
          StrCpy $0 0
        ${EndIf}
        !insertmacro RestartManager_EndSession $R8
      ${EndIf}
      ${If} $0 <> ${ERROR_MORE_DATA}
        ${ExitDo}
      ${EndIf}
      ${If} $R9 = 0
        DetailPrint "Waiting for ${PRODUCTNAME} to close..."
        StrCpy $R9 1
      ${EndIf}
      Sleep 250
    ${Loop}
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

; Closes Fabricator first, with Tauri's own check, which asks before it closes the app unless the
; installer runs silently or for an update. Otherwise Fabricator could restart a sidecar stopped
; before it closes. Tauri runs the same check right after this hook, and then finds nothing to do.
!macro RAYFIN_FABRICATOR_CLOSE_APP
  !ifmacrodef CheckIfAppIsRunning
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !endif
!macroend

; Stops the processes that run $INSTDIR\rayfin-local.exe. The Restart Manager finds them by the
; file they run, as Tauri's check does for the app's own executable. rayfin-local's Node child
; processes stop with it.
!macro RAYFIN_FABRICATOR_STOP_SIDECAR
  ${If} ${FileExists} "$INSTDIR\rayfin-local.exe"
    Push $0
    !insertmacro RestartManager_ShutdownFile "$INSTDIR\rayfin-local.exe" $0
    ${If} $0 <> 0
      DetailPrint "Couldn't stop rayfin-local from $INSTDIR (Restart Manager error $0)."
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro RAYFIN_FABRICATOR_WAIT_FOR_EXIT
  !insertmacro RAYFIN_FABRICATOR_CLOSE_APP
  !insertmacro RAYFIN_FABRICATOR_STOP_SIDECAR
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro RAYFIN_FABRICATOR_CLOSE_APP
  !insertmacro RAYFIN_FABRICATOR_STOP_SIDECAR
!macroend

; Tauri associates .fabricator files, exported projects, with the app (bundle > fileAssociations
; in tauri.conf.json, whose name is the file class below), but gives them the app's own icon, so
; a project file would look like the app. This gives them their document icon, which the
; installer puts in resources (bundle > resources), and tells Explorer to show it. Uninstalling
; removes the file class with its icon. Make the icon again from icons/project-file.png with
; `npx tauri icon icons/project-file.png -o <folder>`: copy its icon.ico to project-file.ico, and
; its icon.icns, which macOS uses (Info.plist), to project-file.icns.
!macro RAYFIN_FABRICATOR_FILE_ICON
  WriteRegStr SHCTX "Software\Classes\RayfinFabricator.Project\DefaultIcon" "" "$INSTDIR\resources\project-file.ico"
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RAYFIN_FABRICATOR_FILE_ICON
!macroend
