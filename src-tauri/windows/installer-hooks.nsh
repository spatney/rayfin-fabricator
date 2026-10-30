; Fabricator's hooks for Tauri's NSIS installer (bundle > windows > nsis > installerHooks).
;
; Fabricator runs rayfin-local, the sidecar installed next to it, as a child process for each
; open project. Windows can't replace or delete a running .exe, so the installer and the
; uninstaller stop the sidecar before they touch its file. They stop only the processes running
; this installation's $INSTDIR\rayfin-local.exe, never every process with that name: a user may
; run their own rayfin-local.

!include "LogicLib.nsh"
!include "Win\RestartManager.nsh"

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
  !insertmacro RAYFIN_FABRICATOR_CLOSE_APP
  !insertmacro RAYFIN_FABRICATOR_STOP_SIDECAR
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro RAYFIN_FABRICATOR_CLOSE_APP
  !insertmacro RAYFIN_FABRICATOR_STOP_SIDECAR
!macroend
