; Assisted installation stays in the current Windows user's account.
; Keep the directory selection page, without offering a machine-wide install.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
