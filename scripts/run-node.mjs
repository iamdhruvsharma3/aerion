import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pinned = readFileSync(join(root, ".nvmrc"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(pinned)) throw new Error("Invalid project Node version.");
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsSystemTrust =
  (major === 22 && minor >= 19) || (major === 24 && minor >= 6) || major > 24;
const installed = join(
  process.env.NVM_DIR || join(homedir(), ".nvm"),
  "versions",
  "node",
  `v${pinned}`,
  "bin",
  "node",
);
const executable = supportsSystemTrust
  ? process.execPath
  : existsSync(installed)
    ? installed
    : null;
if (!executable) {
  console.error(
    `Aerion needs Node 22.19+ or 24.6+ for system certificate trust. Run nvm install in this project, then retry. Pinned version: ${pinned}.`,
  );
  process.exit(1);
}
const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error("A script entry is required.");
// Use the existing OS-managed trust store; certificate and host-name verification remain enabled.
const child = spawn(executable, ["--use-system-ca", "--import", "tsx", entry, ...args], {
  cwd: root,
  env: { ...process.env, NODE_USE_SYSTEM_CA: "1" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Could not start the project Node runtime.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
});
