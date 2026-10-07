#!/bin/sh
# Launch the scratch Helium (never the real one) on a throwaway profile. Prints PID.
# Usage: launch.sh [extra flags...]
P=/tmp/helium-sync-scratch/p9-profile
/tmp/helium-sync-scratch/HeliumScratch.app/Contents/MacOS/Helium \
  --user-data-dir=$P/profile --use-mock-keychain --no-first-run \
  --no-default-browser-check --remote-debugging-port=9361 --enable-logging=stderr --v=0 "$@" \
  >>$P/helium.log 2>&1 &
echo $! > $P/pid
echo $!
