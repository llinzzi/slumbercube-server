#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd ~/slumbercube-server
kill $(pgrep -f "node server.js") 2>/dev/null
sleep 1
nohup node server.js > /tmp/radio_server.log 2>&1 &
echo "Radio server restarted, PID: $!"
