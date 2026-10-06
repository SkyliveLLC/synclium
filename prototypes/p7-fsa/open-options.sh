#!/bin/sh
# Opens the probe's options page in the scratch browser via CDP (port 9337) and prints the probe log.
ID=$(curl -s localhost:9337/json/list | python3 -c 'import json,sys; print(next(t["url"].split("/")[2] for t in json.load(sys.stdin) if t["url"].startswith("chrome-extension://") and t["url"].endswith("/sw.js")))')
curl -s -X PUT "localhost:9337/json/new?chrome-extension://$ID/options.html" >/dev/null && echo "opened chrome-extension://$ID/options.html"
