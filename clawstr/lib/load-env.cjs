/**
 * Env for Clawstr scripts and API mount:
 * 1. Repo-root .env (optional, local)
 * 2. Repo-root .env.clawstr (optional, local)
 * 3. Droplet secrets file (if present) — overrides, so /etc/… wins over stray .env on server
 *
 * Supports KEY=value and export KEY=value. Does not expand shell variables.
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const DROPLET_SECRETS =
  (process.env.SOLANA_AGENT_WEBSITE_SECRETS || "").trim() ||
  "/etc/solana-agent-website/secrets";

function loadEnvFile(filePath, overrideExisting) {
  if (!fs.existsSync(filePath)) return;
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    // Droplet API often runs as non-root; systemd may use EnvironmentFile= same path
    // (vars already in process.env) while the Node user cannot read the file — skip merge.
    if (e && (e.code === "EACCES" || e.code === "EPERM" || e.code === "ENOENT")) return;
    throw e;
  }
  for (let line of text.split("\n")) {
    let t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("export ")) t = t.slice(7).trim();
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (!k || k.startsWith("#")) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (overrideExisting || !process.env[k]) process.env[k] = v;
  }
}

/**
 * Load .env, .env.clawstr, then droplet secrets file (when that file exists).
 * If systemd already sets CLAWSTR_* via EnvironmentFile= the same path, values match;
 * loading again is idempotent for those keys when override runs last.
 */
function loadClawstrRelatedEnv() {
  loadEnvFile(path.join(REPO_ROOT, ".env"), false);
  loadEnvFile(path.join(REPO_ROOT, ".env.clawstr"), false);
  loadEnvFile(DROPLET_SECRETS, true);
}

module.exports = { REPO_ROOT, DROPLET_SECRETS, loadEnvFile, loadClawstrRelatedEnv };
