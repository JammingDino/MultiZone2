; NSIS installer hooks for MultiZone.
;
; An update replaces multizone.exe at the same path it already occupied.
; Explorer caches icons per path and does not always notice that the file
; behind one changed, so a freshly-updated install could keep showing the
; previous (or a blank) icon until the cache happened to age out.
;
; SHCNE_ASSOCCHANGED (0x08000000) tells the shell its icon and association
; state is stale, which is the documented way to make it re-read the icon from
; the new binary. Passing NULL for both paths makes it a global notification.
;
; Explorer integration (0.19.3). Three things, all per-user (HKCU), so they need
; no elevation and the uninstaller takes them with it:
;
;   App Paths\multizone.exe      `multizone` resolves from Win+R and Explorer's
;                                address bar without touching PATH. Typed there
;                                as `multizone .` it opens the folder on screen,
;                                provided Explorer starts it in that folder —
;                                see docs/RELEASE_PLAN.md 0.19.3 for whether it
;                                was seen to.
;   Directory\shell              "Open in MultiZone" on a folder's right-click.
;   Directory\Background\shell   The same, on the empty space inside a folder.
;
; Each verb runs `multizone.exe "<folder>"`, which `launch.rs` opens a chat on —
; in the folder's project when it has one. On Windows 11 the classic verbs sit
; under "Show more options"; the compact top-level menu needs an
; IExplorerCommand handler in a packaged app, which is its own project.
;
; An update re-runs POSTINSTALL with the same $INSTDIR, so the keys always point
; at the binary that is actually there.

; The binary is named inside the macros, not in a !define here: Tauri's template
; includes this file *before* it defines MAINBINARYNAME, and a macro body is
; only expanded where the hook is inserted, after that define exists.
!define MZ_APP_PATHS "Software\Microsoft\Windows\CurrentVersion\App Paths\multizone.exe"
!define MZ_DIR_VERB "Software\Classes\Directory\shell\MultiZone"
!define MZ_BG_VERB "Software\Classes\Directory\Background\shell\MultiZone"

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${MZ_APP_PATHS}" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${MZ_APP_PATHS}" "Path" "$INSTDIR"

  WriteRegStr HKCU "${MZ_DIR_VERB}" "" "Open in MultiZone"
  WriteRegStr HKCU "${MZ_DIR_VERB}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${MZ_DIR_VERB}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; %V is the folder being viewed; a background verb has no %1.
  WriteRegStr HKCU "${MZ_BG_VERB}" "" "Open in MultiZone"
  WriteRegStr HKCU "${MZ_BG_VERB}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${MZ_BG_VERB}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "${MZ_APP_PATHS}"
  DeleteRegKey HKCU "${MZ_DIR_VERB}"
  DeleteRegKey HKCU "${MZ_BG_VERB}"
  ; Same reasoning in reverse: drop the icon for a path that no longer exists
  ; instead of leaving a dead entry behind for the next install to inherit.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
