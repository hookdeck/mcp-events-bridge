# Hermes Agent with a local bridge

[Hermes Agent](https://github.com/NousResearch/hermes-agent) can subscribe to the bridge's events and wake up on each delivery, through a tunnel URL.

**Status: experimental.** Released Hermes (v0.21.5 and earlier) has no MCP Events support. It's in a draft pull request, [hermes-agent#132908](https://github.com/NousResearch/hermes-agent/pull/132908). These steps install that pull request at commit `3cda1278a6`, the version tested with this bridge. The pull request may change or may not be merged, and these steps will change with it.

**Known issue:** Hermes's tools take the bridge's MCP URL, which contains `BRIDGE_MCP_SECRET`, so the secret reaches the model provider, Hermes's session store and its logs. It's [raised on the pull request](https://github.com/NousResearch/hermes-agent/pull/132908#issuecomment-6047465909). Use a local bridge only you can reach, and rotate the secret (change `BRIDGE_MCP_SECRET`, restart `serve`) when you're done testing.

## 1. Install Hermes from the pull request

Needs Python 3.14 and [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/NousResearch/hermes-agent.git && cd hermes-agent
git fetch origin pull/132908/head
git checkout 3cda1278a69a07f1a2e18fe5ed27f76a9e5a6ac6
uv venv --python 3.14 && uv pip install -e ".[anthropic]"
.venv/bin/hermes --version
```

`[anthropic]` installs the Anthropic provider, used in step 4; install the extra for your model provider (`pyproject.toml` lists them). The gateway doesn't install it on demand.

If `git checkout` can't find the commit (the pull request's branch was rewritten), fetch a copy kept on a fork, then check it out again:

```sh
git fetch https://github.com/leggetter/hermes-agent.git mcp-events-pr-132908-3cda127
```

**Success:** the version line ends `local 3cda1278 (+10 carried commits)`.

If you already use Hermes, set `HERMES_HOME` to a new directory for these steps (every `hermes` command below needs it), so this build doesn't change your `~/.hermes`.

## 2. Run the bridge

Run a local bridge (`npx mcp-events-bridge serve`; see the [skill](../SKILL.md), steps 2 and 3) and leave it running.

## 3. Create a tunnel URL for Hermes

Hermes builds every callback URL from one base URL plus its own path, so create one tunnel URL with path `/` for the port Hermes will listen on (Hermes's default is 9901; any free port works):

```sh
npx -y @modelcontextprotocol/inspector --cli "http://127.0.0.1:8080/mcp/$BRIDGE_MCP_SECRET" --transport http \
  --method tools/call --tool-name create_tunnel_url \
  --tool-arg agent=hermes --tool-arg name=base --tool-arg port=9901 --tool-arg path=/
```

**Success:** JSON with `"url": "https://hkdk.events/..."`. That's Hermes's public base URL.

## 4. Configure Hermes

In `$HERMES_HOME/.env` (by default `~/.hermes/.env`), the model provider's key and a webhook secret for Hermes:

```sh
ANTHROPIC_API_KEY=...
MCP_EVENTS_WEBHOOK_SECRET=whsec_...   # generate: echo "whsec_$(openssl rand -base64 32)"
```

In `$HERMES_HOME/config.yaml`:

```yaml
model:
  default: "claude-haiku-4-5-20251001"
  provider: "anthropic"
mcp_events:
  enabled: true
  port: 9901
  public_base_url: "https://hkdk.events/..."   # the tunnel URL from step 3
  trusted_emitters: ["127.0.0.1"]              # the bridge is on loopback, which Hermes refuses otherwise
```

## 5. Start the Hermes gateway

```sh
.venv/bin/hermes gateway run
```

**Success:** `$HERMES_HOME/logs/gateway.log` has `MCP Events: webhook receiver on http://127.0.0.1:9901` and `✓ mcp_events connected`. Leave it running.

## 6. Subscribe

In another terminal:

```sh
.venv/bin/hermes chat --oneshot -q "Use mcp_events_subscribe with emitter_url http://127.0.0.1:8080/mcp/<BRIDGE_MCP_SECRET> and event resend.email.received. Tell me the subscription id."
```

Use an event name from the bridge's `events/list` (`list_providers` shows them).

**Success:** Hermes replies with a `sub_...` id, and `serve` logs `verified callback for owner -> https://hkdk.events/.../mcp/events/webhook/<id>` and `subscribed sub_...`.

## 7. Verify

Trigger a real event for the subscription (for example, send an email to the Resend receiving address).

**Success:**

- `serve` logs `[listen] agent hermes: ... [200] POST http://localhost:9901/mcp/events/webhook/<id>`;
- `gateway.log` has `inbound message: platform=mcp_events` and then `response ready`: the agent ran a session on the event.

To stop, ask Hermes to unsubscribe (`mcp_events_unsubscribe` with the subscription id). The bridge deletes the tunnel URL an hour after no subscription uses it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Subscribing to `http://127.0.0.1:8080/...` is refused | Set `trusted_emitters: ["127.0.0.1"]` and `MCP_EVENTS_WEBHOOK_SECRET` (step 4) |
| A delivery arrives, then `gateway.log` has `Agent error` with `not installed and lazy installs are disabled: ['anthropic']` | Install the provider's extra: `uv pip install -e ".[anthropic]"`, then restart the gateway |
| Subscribe fails with `Unknown event` | Use a name from `events/list`, such as `resend.email.received` |
| Deliveries reach Hermes but nothing runs, with "Unauthorized user" in `gateway.log` | An older commit of the pull request: check out `3cda1278a6` |
| The gateway can't bind its port | Pick another port, in both the tunnel URL (step 3) and `mcp_events.port` |
