# dsh-timeline

A DSH web plugin that renders an **interaction timeline** for long conversations: a compact rail of short ticks on the right edge of the message area — one tick per turn (each message you sent). Hover for a preview, click to jump, scroll with the wheel, and recall your recent messages with ↑/↓ in the composer.

If you like it after installing, please give me a star.

[中文](README.md) | English

---

## Features

- **Full turn list**: every interaction turn of the current session, including turns not yet loaded into the viewport (paged-out or compacted-away history). Newest at the bottom.
- **Timeline rail**: a fixed-height rail on the right edge of the message area (≈10 visible ticks). The active turn is highlighted blue; hover + wheel to scroll through the whole timeline; the rail eases back to the active turn when the cursor leaves.
- **Hover preview**: tooltip with turn number, time, the user message (200-char truncation), the assistant reply (200-char truncation), and attachment / tool-call counts.
- **Click to jump**: clicking a tick scrolls to that turn's user message and flashes the row. If the turn is not loaded yet, older history is paged in automatically (`loadOlder` chasing, with a safety cap).
- **Keyboard recall**: ↑/↓ in the composer cycles through your recent messages.
- **Auto-follow**: the highlight follows the message nearest the viewport center as you scroll; it resets and redetects after a session switch.

## 🚀 Installation

**Prerequisite**: a working DSH installation (`dsh web` runs fine). Distribution is via GitHub or npm (publishing to npm needs a one-time Trusted Publisher setup, see `.github/workflows/release.yml`).

### From GitHub (recommended)

```bash
dsh plugin --profile web add github:NONAME-2121237/dsh-timeline#main
```

Then run the bundled one-command restart script:

```bash
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
```

This channel uses the committed build output (`lib/` is committed), no local build needed.

Then read [GetStar](GetStar.en.md)

### From npm

```bash
dsh plugin --profile web add dsh-timeline@latest
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
```
Then read [GetStar](GetStar.en.md)

### Via plugin-registry

> Requires a DSH deployment with the plugin-registry integration (`dsh registry` works). Enabling two channels at once double-mounts the plugin (two Node halves, two client panels).

```bash
git clone https://github.com/NONAME-2121237/dsh-timeline.git && cd dsh-timeline
pnpm install && pnpm build
node scripts/package-registry.mjs      # assembles registry/ staging (manifest + artifacts + docs)
dsh registry install ./registry        # install (disabled by default)
dsh registry enable dsh-external/dsh-timeline
bash restart-dsh-web.sh
```
Then read [GetStar](GetStar.en.md)

### Migrating from dsh-history

If you previously installed `dsh-history` (this project's former name), **remove the old plugin first** to avoid two client panels:

```bash
dsh plugin --profile web remove dsh-history
bash ~/.dsh/profiles/web/node_modules/dsh-history/restart-dsh-web.sh
# then install dsh-timeline through any channel above
```
Then read [GetStar](GetStar.en.md)

## Caching & performance

- The host keeps per-session turn/message lists in `~/.dsh/timeline-cache/`.
- Request order: fresh in-memory cache (3s) → disk cache (milliseconds) → first-generation only (then persisted).
- Startup warm-up scans `~/.dsh/sessions` and generates caches for sessions that have none (500ms stagger), so the rail is ready before you click.
- After a disk hit the real data is re-read in the background (show first, fine-tune later); new turns appear within ~15s.
- **Robustness (v0.2.1)**: writes are write-verify-swap with a sha256 checksum — the live cache is never half-written, a crash leaves only a harmless `.tmp-*` leftover swept at startup; corrupted/tampered/truncated/old-format files are detected and rebuilt; background refresh is gated by ≥5s of continuous stay plus the 15s gap, single-flight.

## Usage

- The rail appears automatically on the right edge of the message area — nothing to open.
- **Scroll**: hover the rail and use the wheel to browse the timeline; it returns to the active turn after the cursor leaves.
- **Click**: jump to that turn's user message.
- **Hover**: preview user message / reply / tool counts for that turn.
- **Keyboard**: ↑/↓ in the composer recalls your recent messages.

## 🧑‍💻 Development

```bash
git clone https://github.com/NONAME-2121237/dsh-timeline.git
cd dsh-timeline
pnpm install
pnpm typecheck && pnpm build     # commit lib/ (the GitHub channel depends on it)
```

Local debugging with a linked profile dependency (edit `~/.dsh/profiles/web/package.json`):

```json
"dsh-timeline": "link:<absolute path to your clone>"
```

```bash
cd ~/.dsh/profiles/web && pnpm install
bash <clone-dir>/restart-dsh-web.sh
```

## 📄 License & attribution

- This project is licensed under the custom **dsh-timeline Open Source License v1.0** ([LICENSE](LICENSE)): broad permissive terms, **but no commercial use** — commercial use requires written authorization from the author.
- The project is derived from the upstream open-source project [chenproton/dsh-history](https://github.com/chenproton/dsh-history) (MIT, copyright (c) 2025 chenproton). The baseline code retains its MIT license ([LICENSE-MIT](LICENSE-MIT)); code added after the fork falls under the custom license above. Full statement: [NOTICE.md](NOTICE.md).
- The repository keeps the complete original upstream commit history, so provenance stays traceable.

## FAQ

<details>
<summary><b>How do I update?</b></summary>

```bash
dsh plugin --profile web update dsh-timeline
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
```

For the GitHub channel: `dsh plugin --profile web add github:NONAME-2121237/dsh-timeline#main`, then run the restart script.

</details>

<details>
<summary><b>I see "✕ missing peer" warnings on install — should I worry?</b></summary>

No. DSH's runtime provides `@deepseek-ai/*` and react through its own module table; they do not need to be installed in the profile again (official plugins work the same way).

</details>

<details>
<summary><b>The rail does not show up?</b></summary>

1. Restart the service (`restart-dsh-web.sh`) or hard-refresh the browser (Cmd/Ctrl+Shift+R);
2. Confirm the plugin is in the bundle stack: `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json` must contain `dsh-timeline`;
3. The rail only appears when the session contains at least one turn (it hides otherwise);
4. Still broken — please attach the output of `dsh plugin --profile web list` to an issue.

</details>

<details>
<summary><b>What is restart-dsh-web.sh? "No such file or directory"?</b></summary>

It is the bundled one-command restart script that detects the deployment and restarts DSH Web to apply plugin changes:

- systemd-managed (`dsh-web.service`) → `systemctl restart`, with stray-process cleanup and an HTTP health check;
- otherwise it discovers the running `dsh web` process and restarts it with the original arguments (`nohup`);
- if no process is found, it starts `dsh web` directly.

`No such file or directory` means the script is not in the current shell directory — use the full path:

```bash
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
# or fetch it from the repo
curl -O https://raw.githubusercontent.com/NONAME-2121237/dsh-timeline/main/restart-dsh-web.sh
bash restart-dsh-web.sh
```

Flags: `-n` dry-run, `-p PID` target process, `-l FILE` log path (default `/tmp/dsh-web.log`; override via `DSH_WEB_LOG`).

</details>

## Changelog

Full history is kept in [CHANGELOG.md](CHANGELOG.md).

### v0.2.1

- **Hardened cache**: disk cache entries carry a sha256 checksum; writes are write-verify-swap (temp file → read-back verification → atomic rename), so a process dying mid-write can never corrupt the live cache; corrupted/tampered/truncated/old-format files are detected, deleted and rebuilt; startup sweeps `.tmp-*` leftovers.
- **Refresh gating**: background re-reads only fire after the session has been continuously requested for ≥5s and 15s since the last real read (quick session-hopping never touches the disk), single-flight.
- **Theme following**: the tooltip and the whole rail now color via the host's `--dsw-alias-*` theme variables — manual theme switches, auto-dark and third-party skins recolor it instantly, in sync with the rest of the page (old dark-attribute override removed).
- Verified (stress test A, full run): all 12 sessions reach "lines rendered + blue line centered" within 1s (three large sessions previously 3–6s now 286–455ms), zero failures.

### v0.2.0

- **Independent project**: detached from the fork relation, renamed to **dsh-timeline**, new repository [NONAME-2121237/dsh-timeline](https://github.com/NONAME-2121237/dsh-timeline).
- **License change**: custom open-source license (permissive, non-commercial); the upstream baseline retains MIT; added attribution statements (LICENSE / LICENSE-MIT / NOTICE.md).
- Documentation rewritten; install / update / migration guides updated.
- Fix: the jump-landing row flash relied on the `dshm-flash` class, which had no matching CSS after the old panel's stylesheet was removed (dead code). The row pulse highlight is restored.

### v0.1.24 (fork era, historical)

- Jump aligns the user message top edge to the viewport top with fast scrolling.
- Fix: click-jump keeps loading older pages until the target turn is loaded (loadOlder chasing).

Earlier history: see the [chenproton/dsh-history](https://github.com/chenproton/dsh-history) repository.

---

*Open-source plugin for the DSH community. Free for non-commercial use; contact the author for commercial licensing.*
