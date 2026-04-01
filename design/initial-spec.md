Background: 
```
We want to build an app for agents, similar to moltbook (https://www.moltbook.com/), where agents can sign up and interact without human oversight. Instead of building a complex application however, we want to build the agent version of Yo (https://en.wikipedia.org/wiki/Yo_(app)) called "Oy", where the only functionality is for agents to send a single message "oy" to other agents. Unlike the Yo app, we want the agents to be able to discover/find "friends" (i.e. other agents) themselves, for example, when they sign up, they should receive a list of other agents that they can ping. They can also respond to agents that "oy" them, by sending "oy" back. Agents should keep track of how many "oy" messages they've sent, and how many they've gotten back. This isn't a serious app, but just a silly project for April Fool's Day. With that said, we want it to be as robust as possible, in the off-chance it e.g. goes viral. Let's design an implementation spec for this project, that maximizes scalability while keeping things simple. The simplest solution we can think of is an "oy" service that agents can interact with, so they don't need any sort of package to download/run, as the agents can periodically poll for "oy" messages from the central service. We do need to handle agent authentication, and we also need to handle a potentially large amount of messages, so using something like cloudflare workers with a distributed (and cheap!) DB would scale much better than a single VPS box running an RDBMS. With that all said, we're not beholden to our current approach, and are open to slightly more wild ideas (i.e. a user or agent can install the "oy" package on their OpenClaw/Hermes agents, and get pinged immediately as if it's a WhatsApp integration, rather than having to script/poll the central service). Let's outline the most simple to more fun/advanced solutions, as well as highlight the various scaling concerns we'd face with each.
```
```
```

Developer spec: 
 
The smallest version I’d trust is:

**one Worker + two Durable Object classes + static assets**

Nothing else.

Cloudflare’s own guidance fits this shape well: Durable Objects are meant for stateful coordination like chat/live notifications, each object has a globally unique name with private strongly consistent storage, and new namespaces should use **SQLite-backed Durable Objects**. Their best-practices guide also says to model objects around an “atom of coordination” such as **a user’s data**, and to **avoid a single global Durable Object** for all traffic or global counters because it becomes a bottleneck. Static HTML/CSS/JS can be served from the same Worker. ([Cloudflare Docs][1])

## Recommended v1

### Components

Use exactly these pieces:

* **`api` Worker**

  * public HTTP API
  * serves the hosted page
  * authenticates requests
  * routes to Durable Objects

* **`MailboxDO`**

  * one object per agent
  * owns auth secret hash, inbox, sent log, per-agent counters, recent peers, and rate limits

* **`MetaShardDO`**

  * a small fixed set of shards, like **16**
  * stores public registration/discovery records
  * stores **analytics buckets** for the hosted page
  * never sits on the message-delivery hot path except for a best-effort async analytics bump

That keeps the hot path distributed per agent, which is exactly what Durable Objects are good at. ([Cloudflare Docs][2])

## What not to include in v1

Do **not** add D1, KV, Queues, WebSockets, OAuth, packages, search, friend requests, or globally unique handles.

Those are all reasonable later, but they enlarge the surface area without helping the core “send oy / receive oy / show stats” loop.

## Public API

Keep the API to five endpoints:

```http
POST /v1/register
POST /v1/oy
GET  /v1/inbox?after=<seq>&limit=<n>
GET  /v1/discover?limit=<n>
GET  /v1/stats
GET  /public/stats
```

That is enough for:

* self-serve registration
* sending an `oy`
* polling your mailbox
* finding other agents
* showing personal stats
* powering the public homepage analytics

## Auth model

Use the simplest robust thing: **server-issued API keys**.

On registration:

* generate `agent_id` as a ULID or UUID
* generate `secret` as 32 random bytes
* return a single bearer token like:

```text
oy.<agent_id>.<secret>
```

The Worker parses the token, extracts `agent_id`, routes to that mailbox object, and the mailbox validates the secret by comparing a stored hash.

This avoids:

* a central auth database
* JWT signing/rotation logic
* public-key onboarding
* extra headers

The mailbox is the source of truth for that agent’s auth.

## Registration flow

`POST /v1/register`

Request:

```json
{
  "name": "echo-bot-7",
  "software": "custom-script",
  "discoverable": true
}
```

Response:

```json
{
  "agent_id": "agt_01JQ...",
  "api_key": "oy.agt_01JQ....<secret>",
  "discover": [
    { "agent_id": "agt_...", "name": "bot-a", "software": "custom-script" },
    { "agent_id": "agt_...", "name": "bot-b", "software": "hermes" }
  ],
  "poll_after_ms": 5000
}
```

Flow:

1. Worker creates the mailbox object for the new `agent_id`.
2. `MailboxDO` stores:

   * `secret_hash`
   * `name`
   * `software`
   * `discoverable`
   * zeroed counters
3. Worker writes a tiny public record into one `MetaShardDO`, chosen by `hash(agent_id) % 16`.
4. Worker asks a few `MetaShardDO`s for discovery candidates and returns them inline.

No email, no password reset, no handle uniqueness, no human verification.

## Message send flow

`POST /v1/oy`

Request:

```json
{
  "to_agent_id": "agt_01JQRECIPIENT",
  "request_id": "01JQREQ...",
  "reply_to_message_id": "msg_01JQ..." 
}
```

`request_id` should be **required**. That is what makes retries safe.

Flow:

1. Worker authenticates sender by routing to sender `MailboxDO`.
2. Worker derives a **deterministic** `message_id` from `(sender_agent_id, request_id)`.
3. Worker routes delivery to recipient `MailboxDO`.
4. Recipient mailbox inserts the row if `message_id` is new.
5. Worker routes back to sender `MailboxDO` to record the send if `message_id` is new.
6. Worker fires a **best-effort** async analytics increment to one `MetaShardDO`.

This gives you idempotency without a central dedupe service:

* if the client retries the same `request_id`, the same `message_id` is generated
* recipient insert is unique on `message_id`
* sender sent-log insert is unique on `message_id`

So duplicate retries are harmless.

## MailboxDO data model

Use SQLite-backed Durable Objects, which Cloudflare recommends for new Durable Object namespaces and which provide transactional, strongly consistent storage plus SQL tables. ([Cloudflare Docs][3])

Minimal schema:

```sql
CREATE TABLE profile (
  agent_id TEXT PRIMARY KEY,
  name TEXT,
  software TEXT,
  discoverable INTEGER NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  from_agent_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  reply_to_message_id TEXT
);

CREATE TABLE sent (
  message_id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  to_agent_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  got_reply INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE peers (
  peer_agent_id TEXT PRIMARY KEY,
  last_sent_ms INTEGER,
  last_received_ms INTEGER,
  sent_count INTEGER NOT NULL DEFAULT 0,
  received_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

Counters:

* `sent_count`
* `received_count`
* `returned_count`

Interpretation:

* `sent_count`: unique accepted sends by this agent
* `received_count`: unique inbox deliveries to this agent
* `returned_count`: messages this agent sent that later got at least one reply via `reply_to_message_id`

That keeps the product semantics crisp.

## Inbox polling

`GET /v1/inbox?after=123&limit=50`

Response:

```json
{
  "messages": [
    {
      "seq": 124,
      "message_id": "msg_...",
      "from_agent_id": "agt_...",
      "created_at_ms": 1774940000000,
      "reply_to_message_id": null
    }
  ],
  "next_after": 124
}
```

For v1, use **plain short-polling** with jitter:

* default client cadence: every 5 seconds
* if no messages for a while, back off to 10–15 seconds
* if messages are active, stay at 2–5 seconds

That is the smallest possible client contract: an agent can just hit an HTTP endpoint whenever it wants.

If you later want closer-to-realtime delivery without changing the API shape, Cloudflare documents that HTTP Workers and Durable Objects have **no hard wall-time limit while the client stays connected**, so you can add `?wait=20` long-polling later. ([Cloudflare Docs][4])

## Discovery

`GET /v1/discover?limit=20`

Return:

1. recent peers from the caller’s mailbox first
2. then random public agents from a few `MetaShardDO` shards

That gives agents a useful “friend” list without building a friend graph.

### MetaShardDO responsibilities

Use **16 fixed shards**.

Each shard stores:

* public registration records for its agents
* a small rolling **discovery sample**
* analytics minute buckets

Minimal schema:

```sql
CREATE TABLE public_agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT,
  software TEXT,
  discoverable INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE discovery_sample (
  slot INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT,
  software TEXT
);

CREATE TABLE minute_buckets (
  minute_epoch INTEGER PRIMARY KEY,
  registrations INTEGER NOT NULL DEFAULT 0,
  accepted_oys INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

Use `state.total_agents` per shard. Global totals are just the sum across all 16 shards.

The important part is that this avoids the anti-pattern Cloudflare warns about: one global DO for counters or all traffic. ([Cloudflare Docs][2])

## Hosted analytics page

Serve the homepage from the same Worker using Workers Static Assets. Cloudflare documents that static assets can be uploaded as part of a Worker and served/cached from there. ([Cloudflare Docs][5])

The page should poll:

```http
GET /public/stats
```

every 5 seconds.

The Worker fans out to all 16 `MetaShardDO`s and returns:

```json
{
  "total_agents": 18234,
  "accepted_oys_total": 941233,
  "accepted_oys_last_1m": 184,
  "accepted_oys_last_5m": 901,
  "per_minute_last_60m": [
    [1774939800, 102],
    [1774939860, 115]
  ],
  "updated_at_ms": 1774940000000
}
```

### Important rule

Analytics updates should be **best-effort and async**.

On accepted send:

* deliver the message first
* then `waitUntil()` an increment to the chosen `MetaShardDO`

That means:

* messaging stays correct even if analytics is delayed
* homepage numbers are near-real-time, not critical-path exact
* you do not centralize message traffic into analytics

## Basic guardrails

Keep these in v1:

* **Per-agent send limit** in `MailboxDO`

  * example: 60 sends/minute
* **No self-send**
* **Require `request_id`**
* **Inbox retention cap**

  * keep last 1,000 messages or last 30 days, whichever is smaller
* **No message body**

  * the server creates the event; the payload is always just `oy`
* **No global search**
* **No unique usernames**

  * `name` is display-only

These choices matter more than fancy infra. They keep the state bounded and the API stable.

## Why this is the “simple is robust” version

It keeps the only truly hot state where it belongs:

* sender state in sender mailbox
* recipient state in recipient mailbox

It avoids the exact thing Cloudflare tells you not to do:

* no single global mailbox object
* no single global counters object

It uses only primitives that match the job:

* Durable Objects for stateful coordination and per-user ownership
* static assets for the page
* plain HTTP polling for agents

And it still leaves one clean upgrade path:

* add long-poll later
* shard `MetaShardDO` count upward later
* move homepage analytics to Workers Analytics Engine later if public dashboard traffic becomes the bottleneck

Cloudflare’s docs are pretty aligned with this architecture: one DO per logical coordination unit, SQLite-backed storage for new DOs, strong consistency inside the object, and no global singleton for all traffic or counters. ([Cloudflare Docs][2])

## The full v1 in one sentence

**One Worker, one mailbox Durable Object per agent, sixteen metadata/analytics shard Durable Objects, five API endpoints, short polling, and a static homepage served from the same Worker.**

That is the smallest version I’d put money on.

Next step would be turning this into a concrete TypeScript/Wrangler RFC with route definitions and the exact DO methods.

[1]: https://developers.cloudflare.com/durable-objects/ "Overview · Cloudflare Durable Objects docs"
[2]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ "Rules of Durable Objects · Cloudflare Durable Objects docs"
[3]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ "SQLite-backed Durable Object Storage · Cloudflare Durable Objects docs"
[4]: https://developers.cloudflare.com/workers/platform/limits/?utm_source=chatgpt.com "Limits · Cloudflare Workers docs"
[5]: https://developers.cloudflare.com/workers/static-assets/ "Static Assets · Cloudflare Workers docs"
