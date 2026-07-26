# device-control

The module that gives SignalScope a real connection to network devices —
SSH/Telnet CLI and SNMP, for switches and routers, across real hardware, EVE-NG
emulation, and a Docker-based simulator, all through the same code path. This
document records the design decisions behind it, per the working agreement
that this module's decisions get written down as they're made rather than
left implicit in code.

Full design context and rationale for the choices below lives in
`signal-scope-docs/00-architecture/` (`connectivity-methods.md`,
`gui-cli-snmp-unification.md`, `data-model-notes.md`) and
`signal-scope-docs/comparison/` — this module is the implementation of that
research, not a new design done from scratch.

## The core bet, inherited from the docs tree

**The CLI is never abstracted away.** A vendor adapter's `buildCliPlan()`
returns the literal command lines a human would type — no templating DSL —
and every action, whether GUI-initiated, agent-initiated (draining an
offline queue), or a human's raw typed command, is written to
`device_command_audit` as that literal text. See
`adapters/vendor-adapter.interface.ts`.

## Real / emulated / simulated feel identical

A `devices` row has a `connection_kind` (`real` | `eve-ng` |
`docker-simulator` | `planned`) and, separately, a
`device_connection_targets` row saying where/how to actually reach it
(host, port, transport). Every service past `connection/device-connection.service.ts`
— the adapter registry, the action runner, the audit log, the offline
queue — operates on the same `ConnectionTarget` shape regardless of which
kind it is. The only thing that differs across real/EVE-NG/simulator is
what host:port `device_connection_targets` points at.

A **`planned` device** ("ghost" / preconfiguration profile) is a `devices`
row with no connection target yet. It's not a special case in the code —
it's simply always-unreachable, so every action against it lands in
`pending_changes` via the same offline-queue mechanism a genuinely
unreachable real device uses (see below). Attaching a real target later and
flipping `connection_kind` is the only step needed to make it live; nothing
about the queued changes needs to change shape.

## Vendor adapters

`adapters/vendor-adapter.interface.ts` is the contract. Each adapter is a
plain class with no I/O of its own — `buildCliPlan`/`buildSnmpPlan` are
pure functions from a typed `DeviceAction` to literal command text/SNMP
ops, sourced directly from that vendor's `signal-scope-docs/vendors/<vendor>/`
files. `cisco-ios.adapter.ts` is the reference implementation; new vendors
register themselves in `adapters/adapter-registry.service.ts`.

**Adding a new vendor**: implement `VendorAdapter`, transcribing the
literal syntax from that vendor's `gui-cli-snmp-mapping.md`/`cli-reference.md`/
`mib-reference.md` — this should not require new research if the docs tree
already covers the vendor. Register it in `AdapterRegistryService`'s
constructor. Seed `vendor_profiles`/`vendor_capability_defaults` rows (see
`signal-scope-db/migrations/022_seed_vendor_profiles_capabilities.sql` for
the pattern) directly from `comparison/snmp-write-support-matrix.md` and
`cli-syntax-matrix.md`. This phase implements Cisco IOS/IOS-XE, Juniper
Junos, Arista EOS, MikroTik RouterOS; `generic-snmp.adapter.ts` is the
fallback for every other vendor already documented in the docs tree
(Extreme, Huawei, Aruba, Dell, D-Link, Fortinet standalone+FortiLink,
Ubiquiti, Netgear, Zyxel) until it gets its own adapter.

The `DeviceAction` union is deliberately the same action set
`comparison/snmp-write-support-matrix.md` already tracks per vendor — no
new scope was invented for this module.

## SNMP write safety

Before attempting an SNMP SET, `capabilities/capability-registry.service.ts`
checks `device_capabilities` (seeded from `vendor_capability_defaults`,
which is the structured version of the docs tree's own write-support
research). An action with no `confirmed`/`assumed`-and-`supported:true` row
is never attempted via SNMP — it's CLI-only, full stop, matching
`gui-cli-snmp-unification.md`'s standing rule that SNMP SET is never a
default fallback.

## Worker model — Redis + BullMQ

One BullMQ `Queue`+`Worker` pair per device (`queue/device-worker-registry.service.ts`),
created lazily and cached, `concurrency: 1` per device so commands against
the same device never race each other's transport session. Deliberately
**per-job, not per-device-sticky**: each job (`queue/device-action-runner.service.ts`)
owns its transport connection's full lifecycle — dial, login, paging-disable,
run the plan, close — rather than holding a shared session open across
jobs. Any worker process instance can pick up any device's job since each
job pays its own dial+login cost; this is what makes "an agent could live
on another server" true without extra coordination, the property the
worker model was chosen for.

This phase runs the BullMQ `Worker`s in-process with the main NestJS app.
`DeviceActionRunnerService` and `ReachabilityWorkerService` have no
HTTP/controller coupling — extracting a standalone `npm run start:worker`
process later is a wiring change, not a rewrite.

**Known scaling caveat, not solved this phase**: the per-device Queue/Worker
cache never evicts idle entries. Fine for the handful of devices this phase
tests against; a large fleet would need an idle-eviction policy.

## Online/offline sync

`device-control-orchestrator.service.ts` is the decision point: a device
believed down (or `planned`) queues the action into `pending_changes`
without attempting a dial; a device believed up is attempted live and
falls back to the same queue on a transport-level failure. Both paths are
invisible to the API caller as different cases — the response just says
`executed` or `queued`.

`queue/reachability-worker.service.ts` is a repeatable BullMQ job (default
every 30s) that TCP-probes (or SNMP-GETs `sysUpTime` where SNMP creds
exist) every non-`planned` device. A down→up transition triggers
`sync/pending-changes.service.ts#drainForDevice`, which replays queued
changes **through the exact same `DeviceActionRunnerService.execute()`
path a live action uses** — an agent-drained change is indistinguishable
in the audit log from a human one, per the unification doc's rule.

**Known gap, documented rather than silently skipped**: `pending_changes.expected_prior_state`
is recorded when supplied but not yet checked against a fresh read-back
before a drain applies the change — real optimistic-concurrency conflict
detection (the "avoid data corruption" requirement) needs that check
wired in as a fast-follow. Right now a drain applies queued changes FIFO
and stops the whole device's queue on the first failure, rather than
silently skipping or reordering — a safe default, not the full design.

## CLI command sanitization

Two paths, `sanitization/cli-command-sanitizer.ts`:

1. **Structured actions** are sanitized by construction: `dto/device-action.dto.ts`'s
   `toDeviceAction()` validates every field (interface name against that
   vendor's own naming regex, VLAN id range 1–4094, description charset)
   before an adapter ever sees it. No string concatenation from
   unvalidated input reaches a command template.
2. **Raw CLI passthrough** (`POST /device-control/:id/raw-command`, gated
   by the separate `device-control-raw` permission) goes through
   `sanitizeRawCliLine()`: printable-ASCII-only (rules out Telnet IAC bytes
   and ANSI escapes at the source), a 500-char cap, explicit rejection of
   shell metacharacters (`` ` $ ; & \ ``) as defense-in-depth, and a
   curated destructive-command denylist (`reload`, `erase startup-config`,
   `write erase`, `format`, factory-reset variants, Junos
   `request system reboot/halt/zeroize`, MikroTik `/system reset-configuration`,
   etc.) — a denylisted line requires the caller to hold `admin`/`superadmin`
   (mapped to `device-control-raw:manage`), not just `execute`.

**Invariant**: no device-bound command line is ever passed through a local
shell (`child_process.exec`/`spawn` with `shell: true`) anywhere in this
module. Every line is written directly to an SSH (`ssh2`) or Telnet
(`net.Socket`) channel's own stream, which the *remote device's* CLI
interprets — this process's shell is never involved.

## RBAC

Two resources (`role_permissions` seeded in
`signal-scope-db/migrations/021_device_control_permissions.sql`):
`device-control` (structured/guided actions) and `device-control-raw` (raw
passthrough), kept separate so an operator can be granted "click GUI
buttons" without "type arbitrary CLI." `admin`/`superadmin` get `manage` on
both; `operator` gets `execute` on `device-control` but only `read` on
`device-control-raw` by default.

## Credential storage

`crypto/credential-encryption.service.ts` — AES-256-GCM, key from the
required `CREDENTIAL_ENC_KEY` env var. Boot **fails loudly** if it's unset
or the wrong length, deliberately mirroring the lesson from
`AUDIT-REPORT.md` C1 (the JWT secret's silent public-default fallback was a
complete auth bypass) — there is no fallback here, an unset key is a
configuration error. `device_credentials` stores one row per credential
*kind* per device (SSH password/key, Telnet password, enable secret, SNMP
v2c community, SNMPv3 auth/priv, API token) — never a single password
field, per `data-model-notes.md` gap #3.

## Explicitly out of scope this phase

- **Live WS/xterm.js terminal streaming.** `CliChannel.onData()` is the tap
  point for a future gateway; the raw-command endpoint currently runs a
  short-lived dial per request rather than a persistent streamed session.
- **EVE-NG live verification.** `connection_kind='eve-ng'` is fully
  implemented (it's just SSH/Telnet/SNMP to a management IP — no
  EVE-NG-specific code exists or is needed), but EVE-NG was not reachable
  from this environment this session, so no live smoke test against it
  has been run. Verify against it as the next step once reachable — no
  code changes should be needed, only a `device_connection_targets` row.
- **Deep per-vendor `show` output parsing.** `parseReadback()` is
  intentionally minimal (enough to prove the round-trip for the actions
  this phase's tests exercise); real structured parsing of arbitrary
  vendor `show` output is a fast-follow.
- **The other 9 documented vendors' adapters** (Extreme, Huawei, Aruba,
  Dell, D-Link, Fortinet standalone+FortiLink, Ubiquiti, Netgear, Zyxel).
  The schema and adapter interface were designed to accommodate them
  without changes — `device_connection_targets.proxy_device_id`/`proxy_selector`
  specifically anticipate Ubiquiti's controller-first and Fortinet's
  FortiLink-mediated "session target differs from config target" shape —
  but no adapter code exists for them yet.
