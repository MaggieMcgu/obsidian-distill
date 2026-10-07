#!/bin/bash
# Deploy Flint to Obsidian vault for testing

VAULT="${VAULT:-/Users/maggiemcguire/Library/Mobile Documents/iCloud~md~obsidian/Documents/2nd Brain}"
PLUGIN_DIR="$VAULT/.obsidian/plugins/flint"

mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css "$PLUGIN_DIR/"

echo "Deployed to $PLUGIN_DIR"
echo "In Obsidian: Cmd+R to reload, then enable in Settings → Community Plugins"
