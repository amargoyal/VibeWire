; NSIS hooks for the VibeWire installer.
;
; The one thing the installer does beyond copying files: an inbound firewall
; rule for the host's port, so a phone on the same network can reach it. Every
; profile, deliberately — the device handshake is the defence, and the Tailscale
; adapter is usually categorised Public. A failed netsh (declined UAC, policy)
; does not abort the install; the host reports `firewallRuleMissing` instead.

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="VibeWire"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="VibeWire" dir=in action=allow protocol=TCP localport=8787 program="$INSTDIR\VibeWire.exe" profile=any enable=yes'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="VibeWire"'
!macroend
