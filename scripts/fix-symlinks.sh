#!/usr/bin/env bash
###############################################################################
# fix-symlinks.sh — re-create broken .radio_playlist/current.json symlink
#
# After `mv` of the project root, the current.json symlink still points
# at the old absolute path and is now broken. This script:
#   1. Checks if current.json is a valid symlink
#   2. If broken, finds the most recent <stamp>/ dir and re-points
#      current.json at its playlist.json
#
# Run once after a project root rename. Safe to re-run.
###############################################################################
set -u
cd "$(dirname "$0")/.."  # project root
RADIO=".radio_playlist"
SYM="$RADIO/current.json"

if [ -L "$SYM" ] && [ -e "$SYM" ]; then
  echo "OK current.json → $(readlink "$SYM")"
  exit 0
fi

LATEST=$(ls -1d "$RADIO"/[0-9]* 2>/dev/null | tail -1)
if [ -z "$LATEST" ] || [ ! -f "$LATEST/playlist.json" ]; then
  echo "ERROR: no playlist.json found in $RADIO/*"
  exit 1
fi

rm -f "$SYM"
ln -s "$PWD/$LATEST/playlist.json" "$SYM"
echo "FIXED current.json → $PWD/$LATEST/playlist.json"