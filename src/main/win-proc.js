/*
 * win-proc.js — the process list on Windows.
 *
 * agents.js needs four things about every process: its name, its parent, its
 * command line, and how much CPU it has burned. Linux hands all four over in
 * /proc for free, and macOS in one `ps`. Windows has neither — the old code
 * asked it for `ps` anyway, got ENOENT, and swallowed it once a second forever,
 * which is why agent detection did nothing at all on Windows.
 *
 * WHY NOT WMIC
 * `wmic process get ...` is the answer every search returns and it is the wrong
 * one now: it has been disabled by default since Windows 11 23H2, and Microsoft
 * removes it outright at 25H2. Shipping it would be shipping a fix with an
 * expiry date on it.
 *
 * WHY A LONG-LIVED POWERSHELL AND NOT ONE PER POLL
 * `Get-CimInstance Win32_Process` is the supported replacement and it gives all
 * four fields in a single query. What it is not is cheap: enumerating a few
 * hundred processes through WMI costs on the order of a tenth of a second, and
 * starting a PowerShell to ask costs more than the query does. Doing that once a
 * second would make the cat the heaviest thing on the desktop.
 *
 * So PowerShell is started ONCE and keeps the loop itself, printing a snapshot
 * on an interval down a pipe. Node pays for a string split. The process is
 * started lazily, dies with its parent, and is not restarted forever if the
 * machine turns out to have no working WMI.
 *
 * WHY THE INTERVAL IS SLOWER THAN THE POLL
 * Because it can be. CPU is the *fallback* signal — the agents that keep a
 * readable transcript are already answered exactly and for free by
 * agent-sessions.js. Sampling every two seconds instead of every one halves a
 * cost that is real and delays nothing that matters: a turn lasts tens of
 * seconds. agents.js scales its threshold by the interval actually observed, so
 * the bar for "busy" means the same thing here as it does on Linux.
 *
 * `node tools/win-proc-sim.js` replays captured snapshots through the parser
 * without Windows, which is the only part of this that can be tested from here.
 */
const { spawn } = require("child_process");

// How often PowerShell re-enumerates. See the header: this is a cost decision,
// and agents.js is told the real elapsed time so it stays a fair comparison.
const SNAPSHOT_MS = 2000;

// A snapshot older than this is not a process list any more, it is a memory.
// Long enough to ride out one slow WMI query, short enough that a wedged
// PowerShell hands the decision back to the transcripts rather than pinning the
// cat to whatever was true ten seconds ago.
const STALE_MS = 8000;

// A crashed child is worth another go; a machine with no working WMI is not.
// Each attempt costs a process spawn, so this gives up rather than retrying at
// a fixed rate for the lifetime of the app.
const MAX_STARTS = 4;
const RESTART_MS = 5000;

// Marks the end of one snapshot. It cannot collide with a process line: those
// always carry four tabs, and this carries none.
const END = "--pixelcat-end--";

// Fewer rows than this is not a process list. See feed().
const MIN_ROWS = 5;

// Win32_Process reports CPU in 100-nanosecond units. /proc counts in jiffies,
// which are centiseconds, and agents.js compares the two against one threshold —
// so everything is converted to centiseconds on the way in.
const HUNDRED_NS_PER_CS = 100000;

/*
 * The loop runs inside PowerShell, so the only per-interval cost on this side is
 * reading a pipe.
 *
 * `-Property` is not cosmetic: without it WMI materialises every column of
 * Win32_Process for every process, including the expensive ones, and the query
 * takes several times as long.
 *
 * The parent-pid check is how this exits. Killing an Electron main process does
 * not kill its children on Windows, and a PowerShell left looping over WMI
 * forever after the cat was closed would be a genuinely bad thing to ship.
 */
function script(parentPid, intervalMs) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    // Explicitly the no-BOM constructor. Console strips the preamble itself, but
    // a byte order mark landing at the head of the first row would make its pid
    // unparseable, and that is not a failure anyone would enjoy diagnosing from
    // a bug report.
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$out = [Console]::Out",
    "$tab = [char]9",
    `$parent = ${parentPid}`,
    "while ($true) {",
    // How this exits. Killing an Electron main process does not kill its
    // children on Windows, and a PowerShell left looping over WMI forever after
    // the cat was closed would be a genuinely bad thing to ship.
    "  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }",
    "  $procs = Get-CimInstance -ClassName Win32_Process -Property " +
      "ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,CommandLine",
    /*
     * The sentinel is inside this guard, and that is the most important line in
     * the file. SilentlyContinue means a WMI query that fails leaves $procs
     * empty rather than stopping — and an empty snapshot terminated normally
     * would be read on the other side as "this machine is running no processes",
     * which vetoes every transcript and puts Windows back exactly where it
     * started. Windows cannot have zero processes, so empty always means broken,
     * and a broken query must publish NOTHING and let the reader time out into
     * "the process list is unknown".
     */
    "  if ($procs) {",
    "    foreach ($p in $procs) {",
    // A command line cannot be allowed to contain a newline, or one process
    // becomes two rows and the second one is garbage.
    "      $cmd = ([string]$p.CommandLine) -replace '[\\r\\n]+', ' '",
    // uint64 rather than double: the sum is always integral, and an integer
    // formats as plain digits under every locale. A double would be at the mercy
    // of the machine's decimal separator.
    "      $cpu = [uint64]$p.KernelModeTime + [uint64]$p.UserModeTime",
    "      $out.WriteLine((@($p.ProcessId, $p.ParentProcessId, $cpu, $p.Name, $cmd) -join $tab))",
    "    }",
    `    $out.WriteLine('${END}')`,
    "    $out.Flush()",
    "  }",
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    "}",
  ].join("\n");
}

/*
 * One line of a snapshot. Exported because it is the only piece of this file
 * that can be exercised without Windows, and every field in it is a thing that
 * has a real chance of being wrong: the CPU unit, the tab that a command line
 * containing tabs would add, the pid that arrives as a string.
 *
 * The command line is deliberately taken as "everything after the fourth tab"
 * rather than as field five, because that is the only reading that survives a
 * command line with a tab in it.
 */
function parseRow(line) {
  if (!line) return null;
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  const cpu = Number(parts[2]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(cpu)) return null;
  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    cpu: Math.round(cpu / HUNDRED_NS_PER_CS),
    name: parts[3] || "",
    cmd: parts.slice(4).join("\t"),
  };
}

class WinProcSource {
  constructor({ intervalMs = SNAPSHOT_MS } = {}) {
    this.intervalMs = intervalMs;
    this.child = null;
    this.buf = "";
    this.rows = []; // the snapshot currently arriving
    this.snap = null; // the last COMPLETE one; a half-read snapshot is a lie
    this.at = 0;
    this.starts = 0;
    this.stopped = true;
    this.retry = null;
    this.error = "";
  }

  start() {
    this.stopped = false;
    this.spawn();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.snap = null;
    this.rows = [];
    this.buf = "";
  }

  spawn() {
    if (this.stopped || this.child) return;
    if (this.starts >= MAX_STARTS) return;
    this.starts++;

    const src = script(process.pid, this.intervalMs);
    let child;
    try {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-NoLogo",
          // Not strictly needed — an encoded command is not a script file, so
          // execution policy does not apply — but a locked-down machine is
          // exactly where this has to work, and it costs nothing.
          "-ExecutionPolicy",
          "Bypass",
          // The command goes as base64 UTF-16LE rather than as an argument.
          // Quoting a multi-line PowerShell script through argv is a way to
          // lose an afternoon to a backslash.
          "-EncodedCommand",
          Buffer.from(src, "utf16le").toString("base64"),
        ],
        // windowsHide is what passes CREATE_NO_WINDOW. Without it a GUI app
        // spawning a console app gets a black console window on screen — and it
        // would be on top of the cat.
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (err) {
      this.error = err.message;
      return;
    }

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.feed(chunk));
    // Read stderr rather than ignoring it: a stalled pipe would eventually
    // block the child, and the first line of it is the only explanation anyone
    // will ever get for why this did not work.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (!this.error) this.error = String(chunk).trim().split("\n")[0] || "";
    });
    child.on("error", (err) => {
      this.error = err.code === "ENOENT" ? "powershell.exe not found" : err.message;
      this.child = null;
      this.schedule();
    });
    child.on("exit", () => {
      this.child = null;
      this.schedule();
    });
  }

  schedule() {
    if (this.stopped || this.retry || this.starts >= MAX_STARTS) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.spawn();
    }, RESTART_MS);
  }

  // Lines arrive split across chunk boundaries, so the tail is held back until
  // its newline turns up.
  feed(chunk) {
    // A stray byte order mark would otherwise be glued to the first pid of the
    // first snapshot and cost that row. Cheaper to drop than to explain.
    this.buf += String(chunk).replace(/^﻿/, "");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line === END) {
        /*
         * Second line of defence behind the PowerShell's own guard, for the case
         * that guard cannot see: a snapshot that arrived but arrived mangled.
         * A Windows machine that has booted far enough to run this has dozens of
         * processes, so a handful of rows is not a small machine, it is a broken
         * read — and publishing it would claim authority for a list that is
         * missing the very process being looked for.
         */
        if (this.rows.length < MIN_ROWS) {
          this.rows = [];
          if (!this.error) this.error = "snapshot came back implausibly short";
          continue;
        }
        this.snap = this.rows;
        this.at = Date.now();
        this.rows = [];
        // A snapshot arriving is the only proof the query works, so this is
        // where the restart budget is refunded.
        this.starts = 1;
        this.error = "";
        continue;
      }
      const row = parseRow(line);
      if (row) this.rows.push(row);
    }
  }

  /*
   * The last complete snapshot, or null when there is not one worth having.
   *
   * Null is a meaningful answer and callers must treat it as one: it means "the
   * process list is unknown", NOT "nothing is running". agents.js stops using
   * the process list as a veto when it sees null, which is what lets Claude Code
   * and Codex still be detected from their transcripts on a machine where WMI is
   * turned off.
   */
  snapshot() {
    if (!this.snap || Date.now() - this.at > STALE_MS) return null;
    return { rows: this.snap, at: this.at };
  }

  // For tools/agent-probe.js and anyone reading a bug report.
  state() {
    if (this.snapshot()) return { ok: true, detail: `${this.snap.length} processes` };
    if (this.starts >= MAX_STARTS)
      return { ok: false, detail: this.error || "WMI returned nothing; gave up" };
    if (!this.snap) return { ok: false, detail: this.error || "starting" };
    return { ok: false, detail: this.error || "snapshot went stale" };
  }
}

module.exports = { WinProcSource, parseRow, SNAPSHOT_MS, END };
