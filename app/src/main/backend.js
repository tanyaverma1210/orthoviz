// Runs the Python backend (orthoviz-segment) and turns its log output into progress events.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

// TotalSegmentator's full-resolution "total" task runs five models in sequence.
const PREDICTION_PARTS = 5;

// Share of the overall progress bar given to each phase.
const LOAD_END = 0.05;
const PREDICT_START = 0.08;
const PREDICT_END = 0.95;

function backendCommand() {
  return process.env.ORTHOVIZ_BACKEND
    || path.resolve(__dirname, "..", "..", "..", "backend", ".venv", "bin", "orthoviz-segment");
}

/**
 * Tracks progress from backend output lines. Kept free of I/O so it can be unit tested.
 *
 * Progress within prediction comes from tqdm bars ("3/8 [..."), one bar per model part.
 * A bar restarting at 0 marks the start of the next part. This does not depend on
 * TotalSegmentator's "Predicting part k of 5" prints, which can arrive late.
 */
class ProgressParser {
  constructor() {
    this.fraction = 0;
    this.stage = "starting";
    this.part = 0; // 1-based index of the model part being predicted
    this.slices = null;
    this._lastBar = null;
  }

  /** Feed one line; returns true if the progress state changed. */
  feed(line) {
    const key = () => `${this.stage}|${this.part}|${this.fraction.toFixed(4)}`;
    const before = key();

    let m;
    if (/Loading DICOM files/.test(line)) {
      this._set("loading", 0.01);
    } else if ((m = line.match(/Loaded (\d+) slices/))) {
      this.slices = Number(m[1]);
      this._set("loading", LOAD_END);
    } else if (/Running TotalSegmentator/.test(line)) {
      this._set("segmenting", PREDICT_START);
    } else if ((m = line.match(/(\d+)\/(\d+) \[/)) && this.stage === "segmenting") {
      const n = Number(m[1]);
      const total = Number(m[2]);
      // A count that goes backwards (normally to 0) means the next model part has started.
      if (!this._lastBar || n < this._lastBar.n) this.part = Math.min(this.part + 1, PREDICTION_PARTS);
      this._lastBar = { n, total };
      const done = (this.part - 1 + n / total) / PREDICTION_PARTS;
      this._set("segmenting", PREDICT_START + done * (PREDICT_END - PREDICT_START));
    } else if (/Saving segmentations/.test(line) || /Segmentation finished/.test(line)) {
      this._set("saving", PREDICT_END);
    }

    return before !== key();
  }

  _set(stage, fraction) {
    this.stage = stage;
    this.fraction = Math.max(this.fraction, fraction); // never move backwards
  }

  snapshot() {
    return {
      stage: this.stage,
      fraction: this.fraction,
      part: this.part,
      parts: PREDICTION_PARTS,
      slices: this.slices,
    };
  }
}

/** Splits a stream of text into lines, treating "\r" (tqdm redraws) as a line break too. */
function lineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop();
    for (const p of parts) if (p.trim()) onLine(p);
  };
}

/**
 * One backend invocation. Emits:
 *   "progress" {stage, fraction, part, parts, slices, startedAt}
 *   "finished" {ok: true, outputDir} | {ok: false, cancelled, message, details}
 */
class BackendRun extends EventEmitter {
  constructor({ command, dicomFolder, outputDir }) {
    super();
    this.command = command;
    this.dicomFolder = dicomFolder;
    this.outputDir = outputDir;
    this.parser = new ProgressParser();
    this.recentLines = [];
    this.cancelled = false;
    this.child = null;
  }

  start() {
    this.startedAt = Date.now();
    const log = fs.createWriteStream(path.join(this.outputDir, "backend.log"));

    this.child = spawn(this.command, [this.dicomFolder, this.outputDir], {
      cwd: path.dirname(this.outputDir),
      // PYTHONUNBUFFERED makes TotalSegmentator's prints arrive as they happen.
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      // Own process group, so cancel can also stop TotalSegmentator's worker processes.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onLine = (line) => {
      this.recentLines.push(line);
      if (this.recentLines.length > 60) this.recentLines.shift();
      if (this.parser.feed(line)) this._emitProgress();
    };
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.setEncoding("utf8");
      const split = lineSplitter(onLine);
      stream.on("data", (chunk) => {
        log.write(chunk);
        split(chunk);
      });
    }

    this._emitProgress();

    this.child.on("error", (err) => {
      log.end();
      this.emit("finished", { ok: false, cancelled: false, message: `Could not start the backend: ${err.message}`, details: "" });
    });

    this.child.on("close", (code, signal) => {
      log.end();
      if (this.cancelled) {
        this.emit("finished", { ok: false, cancelled: true, message: "Processing was cancelled.", details: "" });
      } else if (code === 0) {
        this.emit("finished", { ok: true, outputDir: this.outputDir });
      } else {
        this.emit("finished", {
          ok: false,
          cancelled: false,
          message: friendlyError(this.recentLines, code, signal),
          details: this.recentLines.join("\n"),
        });
      }
    });
  }

  cancel() {
    if (!this.child || this.child.exitCode !== null) return;
    this.cancelled = true;
    try {
      process.kill(-this.child.pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
  }

  _emitProgress() {
    this.emit("progress", { ...this.parser.snapshot(), startedAt: this.startedAt });
  }
}

function friendlyError(lines, code, signal) {
  const loadError = lines.find((l) => l.includes("Could not load DICOM folder:"));
  if (loadError) {
    return "This folder doesn't look like a CT scan OrthoViz can read: "
      + loadError.split("Could not load DICOM folder:")[1].trim();
  }
  if (signal) return `The processing step stopped unexpectedly (${signal}).`;
  return `The processing step failed (exit code ${code}).`;
}

module.exports = { BackendRun, ProgressParser, lineSplitter, backendCommand, friendlyError, PREDICTION_PARTS };
