#!/bin/sh
# Launch the scratch Helium (never the real one) with the probe extension. Prints PID.
D=$(cd "$(dirname "$0")" && pwd)
/tmp/helium-sync-scratch/HeliumScratch.app/Contents/MacOS/Helium \
  --user-data-dir=/tmp/helium-sync-scratch/p8-apis/profile --use-mock-keychain --no-first-run \
  --no-default-browser-check --remote-debugging-port=9350 --load-extension="$D/ext" \
  >/tmp/helium-sync-scratch/p8-apis/helium.log 2>&1 &
echo $!
