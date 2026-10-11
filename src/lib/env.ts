import path from "node:path";
import fs from "node:fs";

/**
 * Minimal dotenv reader. Avoids a dependency for what is ~20 lines, and keeps
 * behaviour explicit: later files do not silently override earlier ones.
 */
function parseEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load .env.local (and .env) into process.env without overwriting real env vars.
 *
 * On Vercel the variables come from the platform and these files do not exist.
 * The turbopackIgnore marker matters: without it, bundlers read this dynamic
 * path as "the whole working directory" and copy the entire project into the
 * serverless function, which is both slow and a real risk of blowing the
 * 250 MB bundle limit.
 */
function loadEnvFiles(cwd: string): void {
  for (const file of [".env.local", ".env"]) {
    const parsed = parseEnvFile(path.resolve(/* turbopackIgnore: true */ cwd, file));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  loadEnvFiles(process.cwd());
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  if (/REPLACE_ME|YOUR_|<[^>]+>/.test(value)) {
    throw new Error(
      `Environment variable ${name} still contains a placeholder value. ` +
        `Edit .env.local before continuing.`,
    );
  }
  return value.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  loadEnv();
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export function optionalEnvNumber(name: string, fallback: number): number {
  loadEnv();
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
