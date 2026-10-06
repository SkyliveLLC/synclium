#!/bin/sh
# Scratch device B: separate profile, no extension flag (install through Load unpacked so it behaves like a normal install).
exec /tmp/helium-sync-scratch/HeliumScratch.app/Contents/MacOS/Helium --user-data-dir=/tmp/helium-sync-scratch/e2e/profile-B --use-mock-keychain --no-first-run --no-default-browser-check --remote-debugging-port=9341 file:///tmp/helium-sync-scratch/e2e/banner-B.html "$@" >>/tmp/helium-sync-scratch/e2e/browser-B.log 2>&1
