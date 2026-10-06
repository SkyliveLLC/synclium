on guard()
  tell application "System Events"
    set fp to first process whose frontmost is true
    if unix id of fp is not 28542 then error "frontmost is not scratch helium: " & (unix id of fp)
  end tell
end guard
tell application "System Events"
  set sp to first process whose unix id is 28542
  set frontmost of sp to true
  delay 1
  my guard()
  keystroke "g" using {command down, shift down}
  delay 1
  my guard()
  keystroke "/tmp/helium-sync-scratch/p2-ext/ext"
  delay 1
  my guard()
  key code 36
  delay 1.5
  set btns to name of every button of sheet 1 of window 1 of sp
  return btns
end tell
