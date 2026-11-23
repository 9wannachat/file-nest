// Runs the local fake R2 and Vite (with the Worker in workerd) together.
import { spawn } from "node:child_process";

const procs = [
  spawn(process.execPath, ["scripts/fake-s3.ts"], { stdio: "inherit" }),
  spawn("pnpm", ["exec", "vite", ...process.argv.slice(2)], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { stop(); process.exitCode = code ?? 0; }));
