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
 */
const { AgentWatcher } = require("../src/main/agents");

const w = new AgentWatcher((_ch, payload) => {
  const when = new Date().toLocaleTimeString();
  const tag = payload.state === "thinking" ? "THINKING" : payload.quiet ? "done (quiet)" : "DONE";
  console.log(`\n  ${when}  >>> ${tag} — ${payload.name}\n`);
});

w.start();

setInterval(async () => {
  const procs =
    process.platform === "linux" ? w.scanProc() : await w.scanPs().catch(() => []);
  const now = Date.now();

  const live = w.sessions
    .snapshot()
    .filter((s) => now - s.at < 300000)
    .map((s) => `${s.agent}:${s.state}(${Math.round((now - s.at) / 1000)}s)`);

  const trees = procs.map((p) => `${p.name}#${p.pid}=${p.cpu}${p.pct ? `/${p.pct}%` : ""}`);

  console.log(
    `sessions[${w.sessions.sessions.size}] live: ${live.join(" ") || "-"}  |  ` +
      `procs: ${trees.join(" ") || "-"}  |  thinking=${w.thinking} exact=${w.exact}`
  );
}, 1000);

process.on("SIGINT", () => {
  w.stop();
  process.exit(0);
});
