/**
 * Switch speech stacks.
 *   npm run stack              show the stacks and what's reachable
 *   npm run stack -- local     switch: start/stop the local containers, write STACK to .env, restart parley
 *   --no-docker                leave the containers alone
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { STACKS, isStack, localServices } from "../stacks.ts";

const root = join(import.meta.dirname, "..", "..");
const envPath = join(root, ".env");
const composeDir = join(root, "deploy", "local");
const WHISPER_MODEL = "large-v3-turbo-q5_0";
const LOCAL = ["whisper", "kokoro"];

const urls: Record<string, string> = {
  whisper: config.stt.whisperUrl,
  kokoro: `${config.tts.kokoroUrl}/v1/audio/voices`,
};

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500;
  } catch {
    return false;
  }
}

async function waitFor(name: string, timeoutS: number): Promise<boolean> {
  const url = urls[name];
  if (!url) return false;
  const until = Date.now() + timeoutS * 1000;
  process.stdout.write(`waiting for ${name}`);
  while (Date.now() < until) {
    if (await reachable(url)) {
      console.log(" ready");
      return true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(" not up yet (check `docker compose logs` in deploy/local)");
  return false;
}

function compose(args: string[]): void {
  const r = spawnSync("docker", ["compose", ...args], { cwd: composeDir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(" ")} failed`);
}

/** STACK picks STT and TTS, so explicit STT=/TTS= lines (which would win) are commented out. */
function writeStack(name: string): void {
  let s = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  s = s.replace(/^(STT|TTS)=/gm, "# $1=");
  s = /^#? ?STACK=.*$/m.test(s) ? s.replace(/^#? ?STACK=.*$/m, `STACK=${name}`) : `STACK=${name}\n${s}`;
  writeFileSync(envPath, s, { mode: 0o600 });
}

function restartParley(): void {
  const active = spawnSync("systemctl", ["--user", "is-active", "--quiet", "parley"]).status === 0;
  if (active) {
    spawnSync("systemctl", ["--user", "restart", "parley"], { stdio: "inherit" });
    console.log("restarted the parley service");
  } else console.log("restart parley (npm start) to use it");
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));

if (!target) {
  console.log(`current: ${config.stack} (STT ${config.stt.kind}, TTS ${config.tts.kind})\n`);
  for (const [name, s] of Object.entries(STACKS)) console.log(`  ${name.padEnd(7)} ${s.about}`);
  console.log(`\nElevenLabs key: ${config.tts.apiKey ? "set" : "missing"}`);
  for (const name of LOCAL) {
    const url = urls[name] ?? "";
    console.log(`${name}: ${(await reachable(url)) ? "up" : "down"} (${url})`);
  }
  console.log("\nswitch with: npm run stack -- <name>");
} else if (!isStack(target)) {
  console.error(`unknown stack "${target}"; one of: ${Object.keys(STACKS).join(", ")}`);
  process.exitCode = 1;
} else {
  const stack = STACKS[target];
  if ((stack.stt === "elevenlabs" || stack.tts === "elevenlabs") && !config.tts.apiKey)
    console.warn("warning: this stack uses ElevenLabs but ELEVENLABS_API_KEY is empty");
  const needed = localServices(stack);
  if (!args.includes("--no-docker")) {
    if (needed.includes("whisper") && !existsSync(join(composeDir, "models", `ggml-${WHISPER_MODEL}.bin`))) {
      console.log(`downloading whisper ${WHISPER_MODEL} (about 550 MB, once)`);
      compose(["run", "--rm", "whisper", "download-ggml-model.sh", WHISPER_MODEL, "/models"]);
    }
    if (needed.length) compose(["up", "-d", ...needed]);
    // Stop what this stack doesn't use, so whisper isn't holding GPU memory for nothing.
    const idle = LOCAL.filter((n) => !needed.includes(n));
    if (idle.length) compose(["stop", ...idle]);
    // Kokoro fetches its voice model on first start, so give it a few minutes.
    for (const n of needed) await waitFor(n, n === "kokoro" ? 300 : 120);
  }
  writeStack(target);
  console.log(`stack: ${target} (STT ${stack.stt}, TTS ${stack.tts})`);
  restartParley();
}
