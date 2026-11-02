# List-changed test: how MCP clients pick up a changed event list

**Question:** when the bridge's `events/list` (or `tools/list`) changes while it runs, does any MCP client fetch it again, and what signal makes it do so? In earlier testing ChatGPT kept the subscribable events from when the plugin was added until a manual plugin refresh ([`docs/SPIKES.md`](SPIKES.md#chatgpt-on-fly)).

**Status (2 Nov 2026):** Claude Code and Hermes Agent v0.22.5 tested against a local bridge. ChatGPT not yet: its steps are [below](#chatgpt-deployed-bridge-on-flyio), and its rows say "pending".

Branch `test/list-changed`; not for release. Everything is behind environment variables, so a normal bridge is unchanged.

## What the spec says

- **SEP-3415, Dynamic event types** ([PR](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), lines 196 to 214 of the SEP): a server that declares `listChanged: true` in the events extension's settings sends `notifications/events/list_changed` when an event type is added, removed or changes, and the client SHOULD call `events/list` again. It is delivered only on a `subscriptions/listen` stream whose filter has `eventsListChanged: true`, and the server echoes that field in `notifications/subscriptions/acknowledged` if it honors it.
- **MCP 2026-07-28** ([subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)): `subscriptions/listen` replaces the 2025-era HTTP GET notification stream.
- **Caching** ([2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)): `tools/list` and the other list results carry `ttlMs` and `cacheScope`. `events/list` has neither.

## What the bridge and the MCP SDK do today (without the flags)

- **`tools.listChanged: true` is already declared,** on both protocol eras: the SDK's `registerTool` sets it by default (`@modelcontextprotocol/server` 2.3.1, `mcp-*.mjs`, `registerCapabilities({ tools: { listChanged: ... ?? true } })`). The bridge never sends `notifications/tools/list_changed`, because its tools never change.
- **The events capability is `{}`:** no `listChanged`.
- **`tools/list` on 2026-07-28 carries `ttlMs: 0, cacheScope: "private"`** (the SDK's default), so a client that honors it doesn't cache the list. `events/list` carries no hint.
- **The SDK can't carry `eventsListChanged`.** Its `subscriptions/listen` handling (2.3.1, and 2.4.0, the latest) validates the filter against `toolsListChanged`, `promptsListChanged`, `resourcesListChanged` and `resourceSubscriptions`. It strips `eventsListChanged`, and closes a listen that asked for nothing else straight after an empty acknowledgement. Its change events are a fixed set (`tools_list_changed`, `prompts_list_changed`, `resources_list_changed`, `resource_updated`), so it can't send `notifications/events/list_changed` either. The TypeScript client's `listen()` filter type has the same four fields. A newer SDK doesn't help: an extension needs a hook the SDK doesn't have.
- **The SDK refuses the 2025-era GET stream.** `createMcpHandler`'s stateless serving of 2025-era clients answers GET (and DELETE) with `405 Method not allowed`. Only the older, session-based transport serves it.

## Instrumentation

| Variable | What it does |
| --- | --- |
| `BRIDGE_MCP_TRACE=1` | One `mcp-trace` line of JSON per MCP request, response, notification stream opened or closed, and notification written: the HTTP method, JSON-RPC method, protocol version (header and `_meta` or `initialize`), `clientInfo`, user agent, `Mcp-Session-Id`, whether it's a GET stream or `subscriptions/listen` (and its filter), and the tool and event names in each list response, with `ttlMs` and `cacheScope`. Allowlisted fields only: never the `Authorization` header, the secret in the URL, `delivery.secret` or `arguments`. |
| `BRIDGE_LIST_CHANGED_TEST=1` | The test (and the trace). Declares `listChanged: true` for events, in the top-level `events` capability and the extension's settings. Serves `subscriptions/listen` itself, honoring `toolsListChanged` and `eventsListChanged`, and serves a stateless 2025-era GET stream, which gets both notifications. Adds an event type `debug.probe_<n>` and a tool `debug_probe_<n>`. `POST /debug/list-changed?lists=events\|tools\|both` (with `Authorization: Bearer <BRIDGE_MCP_SECRET>`) raises n for those lists and notifies every open stream that opted in; `GET /debug/list-changed` shows both n and the open streams. Subscribing to a probe event fails (it isn't in the catalog), but the attempt is traced. |
| `BRIDGE_LIST_CHANGED_SESSION_ID=1` | With the test: answers a 2025-era `initialize` with an `Mcp-Session-Id`. The Python MCP SDK opens the GET stream only when the server gave it one (`mcp/client/streamable_http.py`, `handle_get_stream`: `if not self.session_id: return`). Requests stay stateless: the SDK ignores the id they echo. |

`scripts/trace-summary.ts` turns `mcp-trace` lines into one short line each; the excerpts below are its output. `scripts/list-changed-bridge.ts` runs the flagged bridge on this machine against a fake Event Gateway (no Hookdeck project), which is all a list test needs.

**Terms.** These are three different ways a client can get a list again, and the tables keep them apart:

- **After the notification:** in the same conversation, with nothing done by hand.
- **New chat:** a new conversation with the same plugin or server, with nothing else done.
- **Manual refresh:** a user action outside the conversation. In ChatGPT, refreshing the plugin in Plugins; in Claude Code, reconnecting with `/mcp`; in Hermes, restarting its gateway.

The n in a probe's name says which version of a list a client has: if the bridge is at `debug_probe_3` and a client calls `debug_probe_2`, its tool list is stale.

## Results

### Claude Code 2.1.316 (control: no MCP Events support)

`claude -p` against the local test bridge, with `--mcp-config` (Bearer header) and `--strict-mcp-config`. The prompt listed its tools, ran a script that bumped tools, slept 5 s, listed them again and called the new probe.

| Question | Answer |
| --- | --- |
| Protocol version | 2026-07-28: `server/discover`, then every request with `_meta` and `MCP-Protocol-Version: 2026-07-28` |
| Opens a notification stream | Yes: `subscriptions/listen` with `{ toolsListChanged: true }`, straight after `server/discover`. Never `eventsListChanged` |
| `tools/list` after `notifications/tools/list_changed` | Yes, 3 ms later; the new tool was callable in the same turn |
| `tools/list` in a new chat | Yes: every `claude` process connects and lists afresh |
| `tools/list` after the bridge restarts | Yes: on the Fly deploy, every connected Claude Code session reopened its listen stream and called `tools/list`, and this session's deferred tool list gained `debug_probe_1` |
| `events/list` | Never |

```
22:09:45.570 #1 IN  POST server/discover {"protocolVersion":"2026-07-28"} claude-code/2.1.316 hdr=2026-07-28 ua=claude-code/2.1.316 (sdk-cli)
22:09:45.598 #2 IN  POST [subscriptions/listen] subscriptions/listen {"protocolVersion":"2026-07-28","notifications":{"toolsListChanged":true}} claude-code/2.1.316 hdr=2026-07-28
22:09:45.599 #2 NOTIFY notifications/subscriptions/acknowledged {"toolsListChanged":true}
22:09:45.607 #3 IN  POST tools/list {"protocolVersion":"2026-07-28"} claude-code/2.1.316 hdr=2026-07-28
22:09:45.611 #3 OUT 200 4ms {"tools":["get_event","list_events","list_sources","poll_events","wait_for_event","debug_probe_1"],"ttlMs":0}
22:09:49.237 #2 NOTIFY notifications/tools/list_changed
-- list-changed test: tools bumped to debug.probe_1 and debug_probe_2; notified 1 of 1 stream(s)
22:09:49.240 #4 IN  POST tools/list {"protocolVersion":"2026-07-28"} claude-code/2.1.316 hdr=2026-07-28
22:09:49.242 #4 OUT 200 2ms {"tools":["get_event","list_events","list_sources","poll_events","wait_for_event","debug_probe_2"],"ttlMs":0}
22:09:57.674 #5 IN  POST tools/call {"protocolVersion":"2026-07-28","name":"debug_probe_2"} claude-code/2.1.316 hdr=2026-07-28
```

On Fly, after the deploy restarted the bridge (one of several sessions):

```
22:20:20.957 #17 IN  POST [subscriptions/listen] subscriptions/listen {"protocolVersion":"2026-07-28","notifications":{"toolsListChanged":true}} claude-code/2.1.316 hdr=2026-07-28 ua=claude-code/2.1.316 (cli)
22:20:20.957 #17 NOTIFY notifications/subscriptions/acknowledged {"toolsListChanged":true}
22:20:21.173 #18 IN  POST tools/list {"protocolVersion":"2026-07-28"} claude-code/2.1.316 hdr=2026-07-28 ua=claude-code/2.1.316 (cli)
22:20:21.183 #18 OUT 200 10ms {"tools":["get_event","list_events","list_sources","poll_events","wait_for_event","debug_probe_1"],"ttlMs":0}
```

### Hermes Agent v0.22.5

Installed from the `v0.22.5` tag (Python 3.14, extras `anthropic` and `mcp`, so `mcp==2.3.0`), with its own `HERMES_HOME`, the bridge as an `mcp_servers` entry with `events: true` and the Bearer header, and `claude-haiku-4-5-20251001`. Each run was `hermes chat --oneshot -q` with no shell tool: list event types and tools, call `wait_for_event` for 40 s, list again, call the probe tool. A script bumped both lists 25 s in, while `wait_for_event` was running.

Every `hermes chat` goes through a local Hermes gateway process (`gateway run --idle-exit`), which the first chat starts. **The gateway holds the MCP connection, so later chats reuse it** (runs 2 and 3); run 4 used a second `HERMES_HOME`, and so a fresh gateway.

| Question | Stateless (runs 1 to 3) | With `Mcp-Session-Id` (run 4) |
| --- | --- | --- |
| Protocol version | 2025-11-25 (`initialize`), though its SDK supports 2026-07-28 | Same |
| Opens a notification stream | No: no session id, so the Python SDK skips the GET stream. (The HEAD and GET before `initialize` are Hermes's connection probes: no `Accept: text/event-stream`, and both get `405`) | Yes: a GET stream straight after `notifications/initialized` |
| `tools/list` after `notifications/tools/list_changed` | No stream, so nothing to react to: the tool list stayed as at connect, and the model called a probe that no longer existed (`-32602 Tool debug_probe_2 not found`) | Yes, but only once the call in progress finished: notified at 22:18:10, `tools/list` at 22:18:35, right after `wait_for_event` returned. Hermes refreshes behind the same lock as its other requests (`tools/mcp_tool_health.py`). The new tool worked in the same chat |
| `tools/list` in a new chat | No: the gateway's connection is reused (runs 2 and 3: no `initialize`, no `tools/list`) | Not tested |
| `events/list` | Live on every `list_event_types` tool call, so the model saw each new probe without any notification | Same. `notifications/events/list_changed` arrived and was dropped: Hermes's message handler only acts on `ToolListChangedNotification`, and logs nothing for it |

Hermes also writes each `tools/list` to `$HERMES_HOME/cache/mcp_schema_cache.json`, for registering tools before it connects, and treats an entry as expired after the `ttlMs` the server gave (`tools/mcp_schema_cache.py`: "Entries without a TTL never expire"). Run 1's entry has `ttl_ms: 0, cache_scope: "private"`, though the 2025-era response it came from carried neither in the trace; where Hermes got them isn't verified.

Run 1, stateless, new gateway:

```
22:12:05.432 #6 IN  HEAD hdr=- ua=python-httpx/0.28.1
22:12:05.435 #7 IN  GET [get] hdr=- ua=python-httpx/0.28.1
22:12:05.435 #7 OUT 405 0ms {"error":{"code":-32000,"message":"Method not allowed."}}
22:12:05.481 #8 IN  POST initialize {"protocolVersion":"2025-11-25"} hermes-agent/0.22.5 hdr=2025-11-25 ua=python-httpx2/2.12.0
22:12:05.490 #8 OUT 200 9ms {"protocolVersion":"2025-11-25","capabilities":{"events":{"listChanged":true},"extensions":{"io.modelcontextprotocol/events":{"listChanged":true}},"tools":{"listChanged":true}}}
22:12:05.492 #9 IN  POST notifications/initialized hdr=2025-11-25 ua=python-httpx2/2.12.0
22:12:05.495 #10 IN  POST tools/list hdr=2025-11-25 ua=python-httpx2/2.12.0
22:12:05.496 #10 OUT 200 1ms {"tools":["get_event","list_events","list_sources","poll_events","wait_for_event","debug_probe_2"]}
22:12:13.869 #11 IN  POST events/list hdr=2025-11-25 ua=python-httpx2/2.12.0
22:12:13.871 #11 OUT 200 2ms {"events":["resend.email.received","debug.probe_1"]}
22:12:16.852 #12 IN  POST tools/call {"name":"wait_for_event"} hdr=2025-11-25 ua=python-httpx2/2.12.0
-- list-changed test: both bumped to debug.probe_2 and debug_probe_3; notified 0 of 0 stream(s)
22:12:56.830 #13 IN  POST events/list hdr=2025-11-25 ua=python-httpx2/2.12.0
22:12:56.833 #13 OUT 200 3ms {"events":["resend.email.received","debug.probe_2"]}
22:12:59.610 #14 IN  POST tools/call {"name":"debug_probe_2"} hdr=2025-11-25 ua=python-httpx2/2.12.0
22:12:59.613 #14 OUT 200 3ms {"error":{"code":-32602,"message":"Tool debug_probe_2 not found"}}
```

(The tool list starts at `debug_probe_2` because the Claude Code run had already bumped tools on this bridge.)

Run 3, a new chat on the same gateway, against a restarted bridge (no `initialize`, no `tools/list`):

```
22:16:39.084 #5 IN  POST events/list hdr=2025-11-25 ua=python-httpx2/2.12.0
22:16:39.085 #5 OUT 200 1ms {"events":["resend.email.received","debug.probe_2"]}
22:16:42.010 #6 IN  POST tools/call {"name":"wait_for_event"} hdr=2025-11-25 ua=python-httpx2/2.12.0
-- list-changed test: both bumped to debug.probe_3 and debug_probe_3; notified 0 of 0 stream(s)
22:17:22.517 #7 IN  POST events/list hdr=2025-11-25 ua=python-httpx2/2.12.0
22:17:22.518 #7 OUT 200 1ms {"events":["resend.email.received","debug.probe_3"]}
22:17:25.504 #8 IN  POST tools/call {"name":"debug_probe_2"} hdr=2025-11-25 ua=python-httpx2/2.12.0
22:17:25.506 #8 OUT 200 2ms {"error":{"code":-32602,"message":"Tool debug_probe_2 not found"}}
```

(Run 2 was the same, except that the bump happened to make the bridge's tool `debug_probe_2` too, so the stale call worked by coincidence.)

Run 4, with `BRIDGE_LIST_CHANGED_SESSION_ID=1` and a new gateway:

```
22:17:49.173 #11 IN  POST initialize {"protocolVersion":"2025-11-25"} hermes-agent/0.22.5 hdr=2025-11-25 ua=python-httpx2/2.12.0
22:17:49.180 #12 IN  POST notifications/initialized hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:17:49.181 #13 IN  GET [get] hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:17:49.182 #13 STREAM 200
22:17:49.183 #14 IN  POST tools/list hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:17:49.185 #14 OUT 200 2ms {"tools":["get_event","list_events","list_sources","poll_events","wait_for_event","debug_probe_3"]}
22:17:57.705 #16 IN  POST tools/call {"name":"wait_for_event"} hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:18:10.205 #13 NOTIFY notifications/events/list_changed
22:18:10.206 #13 NOTIFY notifications/tools/list_changed
-- list-changed test: both bumped to debug.probe_4 and debug_probe_4; notified 1 of 1 stream(s)
22:18:35.752 #16 OUT 200 38047ms
22:18:35.762 #18 IN  POST tools/list hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:18:35.766 #18 OUT 200 4ms {"tools":["get_event","list_events","list_sources","poll_events","wait_for_event","debug_probe_4"]}
22:18:37.454 #19 IN  POST events/list hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:18:37.455 #19 OUT 200 1ms {"events":["resend.email.received","debug.probe_4"]}
22:18:43.080 #20 IN  POST tools/call {"name":"debug_probe_4"} hdr=2025-11-25 sid=lc-7cf5f648-b30d-402d-b9a4-07b8365e0299 ua=python-httpx2/2.12.0
22:18:43.083 #20 OUT 200 3ms
```

Hermes's own log for run 4 has one line for the two notifications: `MCP server 'events-bridge': received tools/list_changed notification`.

### ChatGPT (pending)

| Question | Phase A: stateless | Phase B: with `Mcp-Session-Id` |
| --- | --- | --- |
| Protocol version | pending | pending |
| Opens a notification stream | pending | pending |
| `events/list` after the notification | pending | pending |
| `events/list` in a new chat | pending | pending |
| `events/list` only after a manual refresh | pending | pending |
| `tools/list` after the notification, in a new chat, after a manual refresh | pending | pending |
| Can subscribe to a new event type before a refresh | pending | pending |

## Manual steps

### ChatGPT (deployed bridge on Fly.io)

The Fly app `mcp-events-bridge-dev` runs `test/list-changed` with `BRIDGE_LIST_CHANGED_TEST=1` (deployed 2 Nov with `fly deploy -e BRIDGE_LIST_CHANGED_TEST=1`). In a shell, with `BRIDGE_MCP_SECRET` set to the Fly app's secret:

```sh
B=https://mcp-events-bridge-dev.fly.dev
state() { curl -s -H "Authorization: Bearer $BRIDGE_MCP_SECRET" $B/debug/list-changed; echo; }
bump()  { curl -s -X POST -H "Authorization: Bearer $BRIDGE_MCP_SECRET" "$B/debug/list-changed?lists=$1"; echo; }
```

Other clients on this bridge (your Claude Code sessions with the plugin) also get each tools notification and fetch `tools/list` again; that's harmless, and their lines say `claude-code`, so they're easy to tell apart. ChatGPT's say `openai-mcp` (user agent or `clientInfo`); write down what they actually say.

**Phase A: stateless** (as deployed now)

1. Start capturing: `fly logs -a mcp-events-bridge-dev | tee chatgpt-a.log`, and leave it running.
2. In ChatGPT, open the plugin in Plugins and write down when it was last refreshed, if it says. Don't refresh it yet.
3. Run `state`. Write down the probes (`debug.probe_1`, `debug_probe_1` after a deploy) and whether any stream is ChatGPT's.
4. Open a new Work chat with the plugin. Ask: "Without calling any tool, list the names of the event types you can subscribe to from the events bridge, and the names of its tools you can call." Then: "Call list_sources." (That call is live, so the two answers show cached versus live.)
5. Run `state` again: did ChatGPT open a stream (`kind: "get"` or `"subscriptions/listen"`)?
6. Run `bump both`. Note `notified` in the answer.
7. In the same chat, ask the step 4 question again. Then ask it to subscribe to the newest `debug.probe_<n>` (it will fail: the attempt in the log is the evidence), and to call the newest `debug_probe_<n>` tool.
8. Open a new chat and repeat step 7.
9. Refresh the plugin in Plugins (write down the exact label of the control), open a new chat, and repeat step 7.
10. Run `bump events`, and in the same chat ask the step 4 question again (does a refresh-era chat pick up a later change?).
11. Stop the log capture, and summarize it: `npx tsx scripts/trace-summary.ts < chatgpt-a.log > chatgpt-a.txt`.

**Phase B: with `Mcp-Session-Id`**

12. `fly secrets set BRIDGE_LIST_CHANGED_SESSION_ID=1 -a mcp-events-bridge-dev` (this restarts the bridge, so the probes start again at 1), and wait for `answering 2025-era initialize with an Mcp-Session-Id` in `fly logs`.
13. Repeat steps 1 to 11 with `chatgpt-b.log`. In step 9, refresh the plugin again so ChatGPT goes through `initialize` against this bridge.

Send me `chatgpt-a.txt` and `chatgpt-b.txt` (or the raw logs), and what ChatGPT answered at steps 4, 7, 8, 9 and 10. The trace has no secrets; ChatGPT's answers may name your subscriptions.

### Hermes Agent v0.22.5 (local bridge), interactive

Covered above with one-shot chats; an interactive run checks the same in a long chat. From a `v0.22.5` checkout installed as in the [Hermes guide](../skills/mcp-events-bridge/references/hermes-agent.md) (extras `anthropic,mcp`; `messaging` isn't needed), with a new `HERMES_HOME` whose `config.yaml` points `events-bridge` at `http://127.0.0.1:8090/mcp`:

1. Start the test bridge: `BRIDGE_MCP_SECRET=<value in Hermes's .env> npx tsx scripts/list-changed-bridge.ts 8090 | tee hermes.log`. For the session-id variant, add `BRIDGE_LIST_CHANGED_SESSION_ID=1`.
2. Stop any Hermes gateway for that `HERMES_HOME` (`hermes gateway stop`, or end the `gateway run --idle-exit` process), so the chat connects afresh.
3. `hermes chat`. Ask it to list event types and its events-bridge tools.
4. `curl -X POST -H "Authorization: Bearer $BRIDGE_MCP_SECRET" "http://127.0.0.1:8090/debug/list-changed?lists=both"`.
5. In the same chat, ask again, and ask it to call the newest `debug_probe_<n>` tool.
6. `/new` (or exit and start `hermes chat` again without stopping the gateway), and repeat step 5.
7. `npx tsx scripts/trace-summary.ts < hermes.log`.

### Claude Code (control), interactive

1. Start the test bridge as for Hermes, and `claude mcp add --transport http lcbridge http://127.0.0.1:8090/mcp --header "Authorization: Bearer $BRIDGE_MCP_SECRET"` (remove it afterwards with `claude mcp remove lcbridge`).
2. In an interactive `claude` session, ask it to list its `lcbridge` tools.
3. Bump `tools`, then ask again in the same session, and ask it to call the new probe.
4. Run `/mcp` and reconnect, and in a new session repeat step 2.
5. Summarize the log as above.

## Conclusion so far

- **No client tested calls `events/list` because it was told to.** Claude Code has no MCP Events support. Hermes v0.22.5 drops `notifications/events/list_changed` and doesn't send `eventsListChanged`. ChatGPT is pending.
- **What works for event types today is clients that don't cache `events/list`.** Hermes calls it live on every `list_event_types` tool call, so it sees a new event type at once, with or without a notification.
- **`tools/list_changed` works where a stream exists:** Claude Code (2026-07-28 `subscriptions/listen`) and Hermes (2025-era GET stream). Hermes opens that stream only if the server gives it a session id, and refreshes once any call in progress has finished.
- **Stateless 2025-era serving, the MCP SDK's default, leaves Python SDK clients without a stream,** so they never hear a tools change either. Hermes's gateway keeps its connection across chats, so a new chat doesn't fix it; restarting the gateway does.
- **Nothing in the MCP SDK sends events list changes yet:** a server has to serve `subscriptions/listen` itself, as this branch does.
