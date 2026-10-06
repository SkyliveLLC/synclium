#!/bin/sh
# Launches ONLY the scratch Helium for P7. Never touches the real profile.
exec /tmp/helium-sync-scratch/HeliumScratch.app/Contents/MacOS/Helium --user-data-dir=/Users/conan/Dev/open-synclium/prototypes/p7-fsa/profile --use-mock-keychain --no-first-run --no-default-browser-check --remote-debugging-port=9337 --load-extension=/Users/conan/Dev/open-synclium/prototypes/p7-fsa/ext file:///Users/conan/Dev/open-synclium/prototypes/p7-fsa/banner.html "$@" >>/Users/conan/Dev/open-synclium/prototypes/p7-fsa/browser.log 2>&1
