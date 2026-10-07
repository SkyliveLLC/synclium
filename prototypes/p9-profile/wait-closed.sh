#!/bin/sh
# Wait for the scratch Helium PID we started to exit; kill only that PID after 20s.
P=$(cat /tmp/helium-sync-scratch/p9-profile/pid)
for i in $(seq 1 40); do kill -0 $P 2>/dev/null || { echo "exited $P"; exit 0; }; sleep 0.5; done
echo "hung; killing $P"; kill $P
