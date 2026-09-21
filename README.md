# nativesandbox

Run untrusted code in isolated sandboxes on **any Linux host**. Containers through Podman or
Docker — no nested virtualisation, no KVM, no daemon of its own, and no dependencies.

[nativesandbox.dev](https://nativesandbox.dev) · [Documentation](https://nativesandbox.dev/getting-started/quickstart)

## Why

If you have hit this, you are in the right place:

```
[BootStart] failed to start "…": sandbox process exited
(signal: 6 (SIGABRT) (core dumped)) before agent relay became available
```

That is not a corrupt runtime, and no version of any microVM tool fixes it. It is a host without
`/dev/kvm`. Nested virtualisation is unavailable on all but bare-metal instance types, and on
Oracle's Ampere ARM64 shapes — the free tier a great many small deployments live on — it is not
offered at all.

Containers need no virtualisation, and every Linux host already runs them.

## Try it

```bash
npm install -g nativesandbox
nsbx run "node --version"
```

Or without installing anything: `npx nativesandbox run "node --version"`.

That creates a sandbox, runs the command, streams the output back and removes the sandbox. No
binary to download and no runtime to version-match — the container engine on your host is the
runtime.

If the host is not ready, it will say so:

```bash
nsbx doctor        # what is wrong, if anything
nsbx setup         # fix it, asking before each command
```

`doctor` exits non-zero when the host cannot run sandboxes, so it works as a deployment gate.
`--deep` goes further and creates a real sandbox to prove the kernel is actually holding a
memory limit, rather than accepting it and ignoring it — which looks identical from the outside
and leaves every sandbox unbounded.

## Install

```bash
npm install nativesandbox
```

Node 22+, a Linux host, and Podman or Docker reachable over its socket.

## Use

```ts
import { Sandboxes, MiB } from "nativesandbox";

const sandboxes = new Sandboxes({ root: "/var/tmp/sandboxes" });

const box = await sandboxes.create("job-1", { memory: MiB(512), cpus: 1 });

await box.writeFile("/main.js", "console.log('hello from inside')");
const { stdout } = await box.exec("node main.js");

console.log(stdout);               // hello from inside
await sandboxes.remove("job-1");
```

Ask before you depend on the host, rather than finding out on a user's first command:

```ts
const health = await sandboxes.check();     // never throws
if (!health.ok) throw new Error(health.problem);
```

## What it does

**Reuse that keeps caches warm.** `create()` returns the existing sandbox when its shape still
serves the request. Reuse is *meet-or-exceed*, not equality — a sandbox built with 2 GiB serves a
command asking for 256 MiB, so a dependency install survives between commands instead of going
cold every time.

**A workspace that is a directory.** It is bind-mounted, not copied through an agent channel, so
writing a file is a host write. Measured against a microVM runtime on the same machine: **7×
faster to place 200 files, 49× faster to read them back.** `box.workspaceDir` is the path, and
every tool you already have works on it.

**Commands with the edges handled.** Live output as it is produced, timeouts that kill forked
grandchildren too, `AbortSignal` cancellation reported separately from a timeout, and stdin
closed so a reader gets EOF instead of hanging. A non-zero exit resolves — a failing build is a
result, not an exception.

**Limits that are enforced, in units that cannot be misread.** Memory, CPU and PID ceilings
through cgroups, and a network policy per sandbox. Sizes are a branded type, so `memory: 512`
does not compile: write `MiB(512)` or `GiB(2)`.

**A fleet that reclaims itself.** Idle stop and a hard maximum lifetime, per instance or per
sandbox, recorded on the container so they survive a restart. Neither interrupts a command in
flight, and neither deletes a workspace.

## Isolation

Applied to every sandbox, all verified against a real `npm install` rather than assumed:

| Control | Default |
|---|---|
| Rootless — the container's root is an unprivileged host user | engine |
| Every Linux capability dropped | **on** |
| No new privileges | **on** |
| seccomp, AppArmor | engine |
| Read-only root, with a private `/tmp` | off |

Read-only root is off because it forbids symlinks at the guest root, which some callers need so
that workspace-absolute paths resolve. Turn it on where you do not.

### The trade, stated plainly

This is **process isolation, not hardware isolation**. A sandbox cannot read or write the host,
but the boundary it leans on is the kernel rather than a hypervisor, and that is a weaker
boundary.

It can be narrowed a great deal further, at no cost, with [gVisor](https://gvisor.dev) — a
user-space kernel in front of the syscall interface that still needs no KVM:

```ts
new Sandboxes({ runtime: "runsc" });
```

**If your host has KVM and you want hardware isolation, use a microVM runtime.** This exists for
the hosts that cannot.

## The CLI

`nativesandbox`, or `nsbx` for short.

| | |
|---|---|
| `doctor` | Can this host run sandboxes? `--deep` proves the limits are real |
| `setup` | Apply what doctor found, asking before each command |
| `run` | A throwaway sandbox, streamed, exiting with the command's own status |
| `exec` | A command in a sandbox that already exists |
| `ls` / `rm` / `sweep` | See the fleet, remove from it, reclaim what has gone quiet |

## Documentation

| | |
|---|---|
| [Quickstart](https://nativesandbox.dev/getting-started/quickstart) | Create, run, read back, clean up |
| [CLI](https://nativesandbox.dev/cli/doctor) | doctor, setup, and the sandbox commands |
| [Requirements](https://nativesandbox.dev/getting-started/requirements) | What the host needs, and how to prove it |
| [Isolation](https://nativesandbox.dev/guides/isolation) | What is taken away, and what is not defended against |
| [API reference](https://nativesandbox.dev/api-reference/sandboxes) | Every option and method |
| [Troubleshooting](https://nativesandbox.dev/operations/troubleshooting) | The failures that cost the most time |

## Licence

[Apache-2.0](./LICENSE).
