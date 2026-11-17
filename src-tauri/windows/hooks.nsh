; NSIS installer hooks (Tauri): install the runtime DLLs the AI build loads next to mlp.exe.
; Files are prepared by scripts/prepare-redist.mjs (build.beforeBundleCommand).
; The folder is resolved here, at include time: inside the macros ${__FILEDIR__} would be the
; generated installer's folder instead.
!define MLP_REDIST "${__FILEDIR__}\..\redist"

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath $INSTDIR
  File "${MLP_REDIST}\DirectML.dll"
  File "${MLP_REDIST}\msvcp140.dll"
  File "${MLP_REDIST}\msvcp140_1.dll"
  File "${MLP_REDIST}\vcruntime140.dll"
  File "${MLP_REDIST}\vcruntime140_1.dll"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
  Delete "$INSTDIR\msvcp140.dll"
  Delete "$INSTDIR\msvcp140_1.dll"
  Delete "$INSTDIR\vcruntime140.dll"
  Delete "$INSTDIR\vcruntime140_1.dll"
!macroend
