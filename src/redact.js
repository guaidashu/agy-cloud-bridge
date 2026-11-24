import fs from "node:fs";
import path from "node:path";
import { expandPath } from "./util.js";

const MARK = "«已脱敏»";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bproj_[a-f0-9]{24,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /([?&](?:access_token|ticket|token|key|secret)=)[^\s&"'`]+/gi,
  /(mysql|postgres(?:ql)?|redis|mongodb|amqp|socks5h?|https?):\/\/[^\s"'`@]+:[^\s"'`@]+@[^\s"'`]+/gi,
  /\b(app[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bridge[_-]?secret|project[_-]?token|password|passwd|pwd|secret|proxy[_-]?pass)\b\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
];

function extractEnvSecrets(file) {
  const values = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'\s#]+)["']?/.exec(trimmed);
    if (!match) continue;
    const [, key, val] = match;
    if (/(PASS|SECRET|TOKEN|KEY|AUTH|PWD)/i.test(key) && val.length >= 6) {
      values.push(val);
    }
  }
  return values;
}

export function createRedactor({ config, home, extraSecrets = [] } = {}) {
  const secrets = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim().length >= 6) {
      secrets.add(value.trim());
    }
  };

  add(process.env.AGY_BRIDGE_SECRET);
  for (const s of extraSecrets) add(s);
  for (const p of config?.projects || []) add(p?.token);

  if (home) {
    for (const val of extractEnvSecrets(path.join(home, "secret.env"))) add(val);
    try {
      const cfgRaw = fs.readFileSync(path.join(home, "config.json"), "utf8");
      const parsed = JSON.parse(cfgRaw);
      for (const p of parsed?.projects || []) add(p?.token);
    } catch {
      /* ignore missing/invalid config.json */
    }
  }
  for (const envFile of config?.security?.extraRedactEnvFiles || []) {
    if (!envFile) continue;
    for (const val of extractEnvSecrets(expandPath(envFile))) add(val);
  }

  const sorted = [...secrets].sort((a, b) => b.length - a.length);

  return function redact(text) {
    if (typeof text !== "string" || !text) return { text: text ?? "", changed: false };
    let out = text;
    for (const secret of sorted) {
      if (out.includes(secret)) out = out.split(secret).join(MARK);
    }
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, (match, prefix) =>
        typeof prefix === "string" && /^[?&]/.test(prefix) ? `${prefix}${MARK}` : MARK,
      );
    }
    return { text: out, changed: out !== text };
  };
}

export function redactValue(value, redactFn) {
  if (typeof value === "string") return redactFn(value).text;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactFn));
  if (value && typeof value === "object") {
    const copy = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = redactValue(v, redactFn);
    }
    return copy;
  }
  return value;
}
