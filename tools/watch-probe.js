#!/usr/bin/env node
/*
 * watch-probe.js — show what peek mode sees, without running the cat.
 *
 *   node tools/watch-probe.js
 *
 * Peek mode is a guess dressed as a fact: no platform will say "a video is
 * playing", so each one is asked the nearest question it can answer and the
 * answer is filtered by who gave it. When the guess is wrong there is nothing to
 * read — the cat either sits still through a film or hides during a spreadsheet.
 *
 * So this prints the raw answer next to the verdict. If the cat is hiding for no
 * reason, the owner that caused it is in the output below and belongs in the
 * NOT_MEDIA list for that platform; if it is not hiding during a film, the
 * player is not producing the signal at all and no filter will help.
 */
const { execFile } = require("child_process");
const { WatchDetector, PROBES, SmtcSource, POLL_MS } = require("../src/main/watching");

const platform = process.platform;
const detector = new WatchDetector((active) => {
  console.log(`\n  ${new Date().toLocaleTimeString()}  >>> ${active ? "PEEK" : "COME BACK"}\n`);
});

if (!detector.supported) {
  console.log(`No source on ${platform}. Peek mode does nothing here.`);
  process.exit(0);
}

const indent = (text, max = 24) =>
  String(text)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(0, max)
    .map((l) => `      ${l}`)
    .join("\n");

if (platform === "win32") {
  /*
   * Windows is a resident PowerShell printing a line per poll, so the raw answer
   * is that line: the tag, then every app the system says is playing right now.
   * An app missing from it has not registered with the media session list, which
   * is a thing the cat cannot fix.
   */
  const source = new SmtcSource((value) => {
    console.log(`  playing=${value}   (${source.state().detail})`);
    detector.publish(value === null ? false : value);
  });
  const feed = source.feed.bind(source);
  source.feed = (chunk) => {
    for (const l of String(chunk).split("\n")) if (l.trim()) console.log(`      ${l.trim()}`);
    feed(chunk);
  };
  source.start();
  process.on("SIGINT", () => {
    source.stop();
    process.exit(0);
  });
} else {
  // Everything else forks a small program on an interval. Run the same list the
  // detector runs, in the same order, and show the first one that answers.
  const probes = PROBES[platform];
  const poll = () => {
    let i = 0;
    const next = () => {
      if (i >= probes.length) {
        console.log("  nothing could answer — no probe on this session works");
        return;
      }
      const p = probes[i++];
      execFile(p.bin, p.args, { timeout: 4000 }, (err, stdout) => {
        if (err) return next();
        const value = p.parse(String(stdout));
        if (value === null) return next();
        console.log(`  watching=${value}   via ${p.bin}`);
        console.log(indent(stdout));
        detector.publish(value);
      });
    };
    next();
  };
  poll();
  setInterval(poll, POLL_MS);
}
