import { createRedactor } from "./redact.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger({ level = process.env.AGY_BRIDGE_LOG_LEVEL || "info", redact } = {}) {
  const maxLevel = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const sanitize = redact || createRedactor({});

  function write(lvl, msg) {
    if ((LEVELS[lvl] ?? 2) > maxLevel) return;
    const ts = new Date().toISOString();
    const clean = sanitize(String(msg ?? "")).text;
    const line = `[${ts}] [${lvl.toUpperCase()}] ${clean}\n`;
    if (lvl === "error" || lvl === "warn") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    error: (msg) => write("error", msg),
    warn: (msg) => write("warn", msg),
    info: (msg) => write("info", msg),
    debug: (msg) => write("debug", msg),
  };
}
