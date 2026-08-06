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

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Same reasoning in reverse: drop the icon for a path that no longer exists
  ; instead of leaving a dead entry behind for the next install to inherit.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
