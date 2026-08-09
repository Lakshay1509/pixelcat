#!/usr/bin/env node
/*
 * agent-probe.js — show what the cat sees, without running the cat.
 *
 * Agent detection fails silently by nature: if it is wrong the cat just sits
 * there, and there is nothing to read. This prints the two signals side by side
 * once a second — which transcripts are live and what they say, which process
 * trees matched and what they burned — so a miss can be told apart from a
 * mismatch. Run it in one terminal, drive an agent in another.
 *
 *   node tools/agent-probe.js
 *
 * On Windows it also prints whether the process list exists at all, because
 * there the two signals can fail independently: the transcripts are read
 * straight off disk and always work, while the process list needs a PowerShell
 * that can reach WMI, and a machine where it cannot is a machine where the cat
 * still notices Claude Code and Codex and nothing else. `procs: unavailable`
 * with transcripts still listed is that state, and it is working as intended.
 */
const { AgentWatcher } = require("../src/main/agents");

const w = new AgentWatcher((_ch, payload) => {
  const when = new Date().toLocaleTimeString();
  const tag = payload.state === "thinking" ? "THINKING" : payload.quiet ? "done (quiet)" : "DONE";
  console.log(`\n  ${when}  >>> ${tag} — ${payload.name}\n`);
});

w.start();

setInterval(async () => {
  // The same call the watcher itself makes, so the probe cannot agree with a
  // reality the app does not see.
  const scan = await w.scan().catch(() => ({ procs: [], live: false }));
  const now = Date.now();

  const live = w.sessions
    .snapshot()
    .filter((s) => now - s.at < 300000)
    .map((s) => `${s.agent}:${s.state}(${Math.round((now - s.at) / 1000)}s)`);

  const trees = scan.procs.map((p) => `${p.name}#${p.pid}=${p.cpu}`);
  const procs = !scan.live
    ? `unavailable (${w.win ? w.win.state().detail : "no source"})`
    : trees.join(" ") || "-";

  console.log(
    `sessions[${w.sessions.sessions.size}] live: ${live.join(" ") || "-"}  |  ` +
      `procs: ${procs}  |  thinking=${w.thinking} exact=${w.exact}`
  );
}, 1000);

process.on("SIGINT", () => {
  w.stop();
  process.exit(0);
});
