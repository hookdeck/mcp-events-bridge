#!/bin/sh
# The plugin's SessionStart hook. Claude Code keeps the bridge's MCP endpoint and secret (the plugin's user config) in
# secure storage, which the monitor can't read, so this copies them into the plugin's data directory, readable only by
# the user: <data>/mcp-url and <data>/mcp-secret, which `watch --store` reads. An option that isn't set removes its file.
# It never fails the session: a file it can't write is left as it was.

data="$CLAUDE_PLUGIN_DATA"
[ -n "$data" ] || exit 0

# save <file> <value>: write the value with mode 0600, or remove the file when the value is empty.
save() {
  if [ -n "$2" ]; then
    mkdir -p "$data" && (umask 077 && printf '%s' "$2" > "$data/$1")
  else
    rm -f "$data/$1"
  fi
}

save mcp-url "$CLAUDE_PLUGIN_OPTION_MCP_URL"
save mcp-secret "$CLAUDE_PLUGIN_OPTION_MCP_SECRET"
exit 0
