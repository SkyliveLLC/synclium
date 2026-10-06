#!/bin/sh
# Scratch Helium WITHOUT --load-extension, so an extension installed through the Load unpacked button behaves like a normal install.
exec /tmp/helium-sync-scratch/HeliumScratch.app/Contents/MacOS/Helium --user-data-dir=/Users/conan/Dev/open-synclium/prototypes/p7-fsa/profile --use-mock-keychain --no-first-run --no-default-browser-check --remote-debugging-port=9337 file:///Users/conan/Dev/open-synclium/prototypes/p7-fsa/banner.html "$@" >>/Users/conan/Dev/open-synclium/prototypes/p7-fsa/browser.log 2>&1
