#!/bin/sh
# Scratch device A: separate profile, no extension flag (install through Load unpacked so it behaves like a normal install).
exec /tmp/helium-sync-scratch/HeliumScratch.app/Contents/MacOS/Helium --user-data-dir=/tmp/helium-sync-scratch/e2e/profile-A --use-mock-keychain --no-first-run --no-default-browser-check --remote-debugging-port=9340 file:///tmp/helium-sync-scratch/e2e/banner-A.html "$@" >>/tmp/helium-sync-scratch/e2e/browser-A.log 2>&1
