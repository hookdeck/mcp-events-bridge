#!/bin/sh
# The plugin's monitor: runs `watch` for the whole session on this project's watch list, kept in the plugin's data
# directory. Claude's plugin directory refuses a monitor command with any variable but ${CLAUDE_PLUGIN_ROOT}, and Claude
# Code doesn't give a monitor CLAUDE_PLUGIN_DATA or CLAUDE_PROJECT_DIR in its environment, so this finds them itself:
# - The data directory: MCP_EVENTS_BRIDGE_PLUGIN_DATA, which the session start hook writes to CLAUDE_ENV_FILE first
#   thing (Claude Code starts the monitor with it, if the hook got there first); else worked out from where the plugin
#   is installed, <plugins>/cache/<marketplace>/mcp-events-bridge/<version>, as <plugins>/data/mcp-events-bridge-<marketplace>.
# - The project: the working directory, which is the session's when the monitor starts.

root=$(cd "$(dirname "$0")/.." && pwd -P) || exit 1

data="$MCP_EVENTS_BRIDGE_PLUGIN_DATA"
if [ -z "$data" ]; then
  plugin_dir=$(dirname "$root")
  marketplace_dir=$(dirname "$plugin_dir")
  cache_dir=$(dirname "$marketplace_dir")
  if [ "$(basename "$cache_dir")" = cache ] && [ "$(basename "$plugin_dir")" = mcp-events-bridge ]; then
    data="$(dirname "$cache_dir")/data/mcp-events-bridge-$(basename "$marketplace_dir")"
  fi
fi

if [ -z "$data" ]; then
  echo '{"problem": "the plugin cannot find its data directory, so it cannot watch: start a new session, and if this repeats, reinstall the plugin"}'
  exit 1
fi

exec "$root/bin/events-bridge" watch --store "$data" --project "$PWD"
