import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirementsPath = path.join(rootDir, "python", "requirements-image-sandbox.txt");
const venvDir = path.join(rootDir, ".python-sandbox");
const stampPath = path.join(venvDir, ".requirements.hash");
const pythonBin = path.join(venvDir, "bin", "python");
const pipBin = path.join(venvDir, "bin", "pip");

if (process.env.SKIP_PYTHON_SANDBOX_SETUP === "1") {
  process.exit(0);
}

const requirementsHash = createHash("sha256")
  .update(readFileSync(requirementsPath, "utf8"))
  .digest("hex");

if (existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === requirementsHash && existsSync(pythonBin)) {
  process.exit(0);
}

run("python3", ["-m", "venv", venvDir], "create python sandbox venv");
run(pipBin, ["install", "--disable-pip-version-check", "--no-cache-dir", "-r", requirementsPath], "install python sandbox deps");
writeFileSync(stampPath, `${requirementsHash}\n`, "utf8");

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${label}`);
  }
}
