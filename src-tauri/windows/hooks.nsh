; NSIS installer hooks (Tauri): install the runtime DLLs the AI build loads next to mlp.exe.
; Files are prepared by scripts/prepare-redist.mjs (build.beforeBundleCommand).
; The folder is resolved here, at include time: inside the macros ${__FILEDIR__} would be the
; generated installer's folder instead.
!define MLP_REDIST "${__FILEDIR__}\..\redist"

; Full package (scripts/build-full.mjs): an "ai-data" folder next to setup.exe holds every AI download
; (Whisper engines + models, vocal isolation, auto-sync, Japanese dictionary), ~4 GB, too big for one
; NSIS installer (2 GB limit). It is copied to $INSTDIR\ai, which the app checks before downloading.
; The plain setup.exe (updates, GitHub release) has no ai-data folder and skips this.

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath $INSTDIR
  File "${MLP_REDIST}\DirectML.dll"
  File "${MLP_REDIST}\msvcp140.dll"
  File "${MLP_REDIST}\msvcp140_1.dll"
  File "${MLP_REDIST}\vcruntime140.dll"
  File "${MLP_REDIST}\vcruntime140_1.dll"
  File "${MLP_REDIST}\vcomp140.dll"
  ${If} ${FileExists} "$EXEDIR\ai-data\models\*.*"
    DetailPrint "Installing the AI models (about 4 GB, this takes a minute)..."
    CreateDirectory "$INSTDIR\ai"
    ClearErrors
    CopyFiles /SILENT "$EXEDIR\ai-data\*.*" "$INSTDIR\ai"
    ${If} ${Errors}
      MessageBox MB_ICONEXCLAMATION|MB_OK "Some AI models couldn't be copied (is the disk full?). MLP will download what is missing when it needs it."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
  Delete "$INSTDIR\msvcp140.dll"
  Delete "$INSTDIR\msvcp140_1.dll"
  Delete "$INSTDIR\vcruntime140.dll"
  Delete "$INSTDIR\vcruntime140_1.dll"
  Delete "$INSTDIR\vcomp140.dll"
  ; Updates keep the installed AI models; a real uninstall removes them.
  ${If} $UpdateMode <> 1
    RMDir /r "$INSTDIR\ai"
  ${EndIf}
  RMDir "$INSTDIR"
!macroend
