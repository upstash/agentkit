# @upstash/agentkit-deepseek

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins backed by
[Upstash Redis](https://upstash.com/).

Today that means one thing: a **durable session-persistence backend** — a drop-in replacement for the
harness's shipped JSONL and SQLite backends that keeps session transcripts in Redis instead of on the
machine that happened to run the turn.

| Harness backend | Where sessions live |
| --- | --- |
| `dsh-session-persistence-jsonl` | one `.jsonl.zstd` file per session, on local disk |
| `dsh-session-persistence-sqlite` | rows in a local SQLite database |
| **this package** | **keys in Upstash Redis, reachable over HTTP from anywhere** |

That difference is the point. A serverless, containerized, or multi-replica deployment has no durable
local disk to write to and no shared one to read back from, so sessions cannot survive a restart or
be resumed by a different instance. Redis is reachable over HTTP from all of them.

## Install

```bash
npm install @upstash/agentkit-deepseek
```

Peers you already have in a harness deployment: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-session`,
and `@deepseek-ai/dsh-session-persistence`. They are peers because the harness genuinely provides
them, and a second copy of `dsh-session-persistence` would break service identity.

`@upstash/redis` is a plain **dependency**, not a peer: the host here is `dsh`, which knows nothing
about Redis, so nothing in a profile would ever satisfy that peer — and this plugin builds its own
client via `Redis.fromEnv()` rather than sharing yours.

## Wire it up

The package is a **bundle**: it ships a `cordis.patch.yml` layer, so installing it into a profile is
the whole setup.

```bash
dsh plugin --profile web add @upstash/agentkit-deepseek
dsh web
```

> **Pick the profile you actually boot.** A profile is one runnable composition at
> `~/.dsh/profiles/<name>/`, and a plugin installs into exactly one of them. `dsh web` is a hardcoded
> alias for `--profile web`, and `dsh --profile headless` boots `headless` — so installing into
> `demo` and then running `dsh web` silently changes nothing. Examples below use `web`; substitute
> your own. Running the CLI through `npx @deepseek-ai/dsh …` works the same way: the CLI is cached,
> but the profile directory is durable on-disk state.

## Credentials

The backend needs `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Nothing goes in a config
file — a config row names the *reference*, never the value.

The recommended way is this package's own command, which needs no hand-edited file:

```bash
dsh plugin --profile web exec agentkit-deepseek credentials set
# Upstash REST URL: https://xxx.upstash.io
# Upstash REST token: (not echoed)

dsh plugin --profile web exec agentkit-deepseek credentials status
# UPSTASH_REDIS_REST_URL: configured (source: file)
# UPSTASH_REDIS_REST_TOKEN: configured (source: file)
```

Running it through `dsh plugin … exec` puts it in the profile directory, where both this package and
the harness's credentials provider resolve. It writes `~/.dsh/.credentials.yaml` through the
harness's own provider, so the atomic write, cross-process lock, and `0600` permissions are the
harness's code rather than ours. Restart `dsh` afterwards.

Prefer the prompt over `--token`: a flag lands in your shell history and process list.

### Where a credential can come from

The backend resolves through `ctx.credentials` when a provider is mounted (the shipped bundles mount
one), which searches every layer, then falls back to `Redis.fromEnv()`:

| Layer | Set it with | Notes |
| --- | --- | --- |
| launching shell / CI / container | `VAR=… dsh web` | Wins over everything; per-run operator intent |
| `~/.dsh/.credentials.yaml` | `agentkit-deepseek credentials set` | Managed store, hot-reloaded, `0600` |
| `<invoking directory>/.env` | edit the file | The project you launch from |
| `~/.dsh/.env` | edit the file | Machine-level default |

`.env` files are also materialized into `process.env`, so they work with or without a credentials
provider — which is why `Redis.fromEnv()` remains the fallback and this package still runs unchanged
outside the harness.

One consequence of that precedence worth knowing: **`credentials set` refuses to write a reference
your shell already exports**, because a higher layer would shadow it. The error names the fix
(`unset` it in the launching shell). `credentials status` shows which layer currently wins.

To point at differently named references — a second Upstash database, or a house naming convention —
set `urlRef` / `tokenRef` on the row, and pass the matching `--url-ref` / `--token-ref` to the
command. This is the harness's own `apiKeyEnv` pattern: config names the credential, never holds it.

⚠️ **Do not inline credentials in `cordis.yml` / `cordis.patch.yml`.** Config files are the layer
people commit, copy between machines, and paste into bug reports. `--dump-config` prints composed
`config` values verbatim while leaving `!!js` expressions unevaluated, so a literal secret leaks
there and a reference does not.

The layer disables the base bundle's local-disk row and inserts this one:

```yaml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-redis
      name: '@upstash/agentkit-deepseek'
```

⚠️ **Replace a row by disabling it and inserting another — never by patching its `name`.** The
patcher treats a patch's `name` as an *assertion about the target* and skips the entire patch when it
does not match the row's current name. So this looks right and does nothing at all, leaving the JSONL
backend running:

```yaml
# WRONG — warns "name mismatch ... skipping" and changes nothing.
- id: session-persistence-jsonl
  name: '@upstash/agentkit-deepseek'
```

To tune the backend, override the inserted row from your profile's `cordis.patch.yml`, which applies
after every bundle layer. A patch replaces a row's whole `config` rather than merging into it, so
restate every key that row needs:

```yaml
- id: session-persistence-redis
  config:
    prefix: 'myapp:sessions'
    writeBatchMaxDelayMs: 500
```

`dsh web --dump-config` prints the composed tree without booting — the quickest way to
confirm the swap landed.

Programmatically, it is an ordinary cordis plugin:

```ts
import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import RedisSessionPersistence from "@upstash/agentkit-deepseek";

const ctx = new Context();
await ctx.plugin(SessionStore);
await ctx.plugin(RedisSessionPersistence, { prefix: "dsh:session" });

// ctx.sessionPersistence is now the Redis backend.
```

## Config

| Key | Type | Notes |
| --- | --- | --- |
| `prefix` | `string` (default `dsh:session`) | Base key prefix. Two backends on one database with different prefixes share nothing — including store identity — so their revisions can never compare equal. |
| `ttlSeconds` | positive integer | Expiry refreshed on every write. Omitted (the default) keeps sessions forever, which is what the append-only contract assumes. See the warning below. |
| `preparedSessionCacheSize` | positive integer (default `5`) | Cold `Session` preparations retained for history-to-resume reuse. |
| `writeBatchMaxDelayMs` | positive integer (default `200`) | Fixed coalescing window after an idle live-event queue receives work. Later events do not reset it; flush and teardown bypass it. It does not bound network or backend latency. |
| `urlRef` | `string` (default `UPSTASH_REDIS_REST_URL`) | Credential *reference* holding the REST URL — names the credential, never the value. |
| `tokenRef` | `string` (default `UPSTASH_REDIS_REST_TOKEN`) | Credential reference holding the REST token. |
| `redis` | `Redis` | Runtime-only seam, **not** settable from `cordis.yml` — a client instance is not a config value. Omit it and the backend resolves through `ctx.credentials`, then `Redis.fromEnv()`. |

⚠️ **`ttlSeconds` is a data-loss knob.** The persistence seam has no deletion or retention API
precisely because a stored session is meant to outlive the process. An expired log is *gone*, not
repairable, and the session it belonged to can no longer be resumed. Use it for ephemeral or preview
deployments; leave it off for anything a user may come back to.

## Key layout

```
<prefix>:store            # string — this store's generated identity (SET NX once)
<prefix>:ids              # set    — every materialized session id
<prefix>:meta:<id>        # hash   — { meta, incarnation, revision }
<prefix>:events:<id>      # list   — one JSON-encoded SessionEvent per element
```

The events **list** is the load-bearing choice. A session log is append-only with contiguous `seq`
starting at 0, so **list index === event seq**. That single fact gives the whole backend its
primitives: `LLEN` is the stored next-seq, `LRANGE key fromSeq -1` is a real seek read, and `LTRIM`
is a tail truncation.

Being able to seek matters for the seam's `readFrom`, the read-model primitive that resumes from a
watermark. This backend implements the optional `loadStoredFrom` hook, so `readFrom` scales with the
suffix it returns — like SQLite's `WHERE seq >= ?`, and unlike JSONL, which must parse the whole
artifact and skip forward.

## Durability and crash semantics

Like the two first-party backends, this one composes the shared `PersistenceCoordinator` and
implements only the small `PersistenceBackend` storage-hook interface. Everything correctness-heavy
in the write path — batching, per-id serialization, lazy materialization, crash-repair sequencing,
session adoption, quiescent disposal — is the harness's own code, identical across all three
backends. What is written here is storage primitives.

- **Atomic append.** Materializing a session's header and writing its first event batch happen in one
  `EVAL`. Redis runs a script to completion without interleaving, which is the same boundary SQLite
  gets from a transaction: a crash cannot leave a materialized-but-empty session.
- **No torn tails.** Because every mutation is one script, this backend cannot produce a partially
  written record. Truncation is still implemented, so a key damaged from outside the backend is
  repairable rather than fatal.
- **Contiguous seq, enforced in storage.** `LLEN` *is* the stored next-seq, so the append script
  rejects a batch whose first seq disagrees before writing anything. A second writer for the same
  session — another process, a stale instance — fails loudly instead of silently interleaving.
- **Consistent reads.** One session's header, events, and revision are read in a single script. Two
  round trips could straddle a concurrent append and return a revision describing a different prefix,
  which the seam forbids.
- **Store-qualified revisions.** Revisions must not compare equal across independently backed stores,
  and a per-session counter cannot promise that — two databases both start at 1. A `SET NX` store id,
  written once per prefix, qualifies every revision.
- **Crash recovery.** Unchanged from the seam: `load` preserves a complete interrupted turn and
  durably closes it with synthetic `tool/result` / `step/end` / `turn/end {interrupted}` closers,
  rather than truncating real work.

The package's test suite runs the harness's **own** backend-agnostic conformance suite
(`runPersistenceContract`) — the one the JSONL and SQLite backends are held to — against a real
Upstash Redis, plus Redis-specific tests for key layout, seek reads, store identity, the atomic
append guard, out-of-band tail repair, and TTL.

## Using it without publishing

You never have to release this to run it in a real harness. `dsh plugin` forwards its arguments to
pnpm inside the profile directory, so **any specifier pnpm accepts works** — a local path, a tarball,
a git URL, or a registry package. Only the last of those involves publishing.

| Route | Publish? | Notes |
| --- | --- | --- |
| Local path | no | Linked, not copied. Best for developing. |
| `--patch` overlay | no | Not installed at all. Fastest iteration. |
| Tarball (`pnpm pack`) | no | Ships built output. Best for handing to a teammate or CI. |
| Git URL | no | No registry, but see the build-script catch below. |
| npm registry | yes | Ordinary install. |

**Install it from a local checkout.** `dsh plugin` forwards to pnpm inside the profile directory, so
a path dependency is *linked*, not copied — and because this package declares `dsh.bundle`, its layer
activates exactly as it would from npm:

```bash
pnpm --filter @upstash/agentkit-deepseek build
dsh plugin --profile web add /absolute/path/to/redis-agentkit/packages/deepseek
dsh web --dump-config   # shows a "# == @upstash/agentkit-deepseek" layer
dsh web
```

Since pnpm links rather than copies, a later `pnpm build` is picked up on the next boot — no
reinstall. `dsh plugin --profile web remove @upstash/agentkit-deepseek` takes back both the
dependency and the layer.

**Or skip installation entirely** and drive it from a `--patch` overlay pointing at the built entry
point by absolute path:

```yaml
# redis-sessions.cordis.yml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-redis
      name: '/absolute/path/to/redis-agentkit/packages/deepseek/dist/index.js'
```

```bash
dsh web --patch ./redis-sessions.cordis.yml
```

`--patch` overlays apply last, after every bundle layer and the profile's own, so this also works as
a temporary override on top of a normally installed copy. The path is machine-specific, which makes
it a development tool rather than something to commit.

**Or hand someone a tarball.** For distributing to a teammate or a CI image without a registry:

```bash
pnpm --filter @upstash/agentkit-deepseek build
pnpm --filter @upstash/agentkit-deepseek pack       # → upstash-agentkit-deepseek-0.1.0.tgz
dsh plugin --profile web add ./upstash-agentkit-deepseek-0.1.0.tgz
```

The tarball carries `dist/`, `cordis.patch.yml`, and the `dsh.bundle` manifest, so it installs and
activates exactly like a registry copy — and because it contains built output, the recipient needs no
build permission.

**The one route with a catch is a git install.** `dsh plugin add github:you/repo` also needs no
registry, but pnpm fetches **sources, not build output**, so nothing produces `dist/` and the plugin
fails to load. That route additionally requires a `prepare` script on the author's side and, on the
user's side, an explicit `allowBuilds` entry in the profile's `pnpm-workspace.yaml` — which is
permission to execute the package's code at install time, outside any sandbox. This package ships no
`prepare` script (an install-time build is fragile in a monorepo), so prefer a path, tarball, or
registry install.

## Known limitations

- **No deletion or retention API.** That is the seam's stance, not this backend's: pruning stored
  sessions is out-of-band maintenance. `ttlSeconds` is the one lever, with the caveat above.
- **`list()` is unpaginated and unfiltered.** It returns every stored session's header, one pipelined
  `HMGET` per session. Fine for a normal store; unindexed at scale.
- **No raw artifact.** Redis holds a keyspace, not a file per session, so `locate()` returns
  `undefined` and `supportsRawArtifacts` is `false` — the same answer the SQLite backend gives.
- **One live writer per session.** Append and repair are coordinated inside the owning backend
  instance. The append script's seq guard turns a second concurrent writer into a loud failure rather
  than a corrupted log, but it does not make concurrent writers *work*.

## License

MIT
