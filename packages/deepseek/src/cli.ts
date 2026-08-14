#!/usr/bin/env node
/**
 * `agentkit-deepseek` — store the Upstash connection in the harness's own
 * credentials document, so nobody has to hand-edit YAML.
 *
 * The DeepSeek Harness has no CLI for writing credentials (`dsh` has exactly two
 * subcommands, `web` and `plugin`), and its Web UI cannot help here either: the
 * Models page is LLM-provider-specific, and the generic plugin-settings section
 * gates card exposure behind a Host allowlist compiled into the harness, so a
 * plugin distributed outside that repository cannot surface its own
 * configuration there.
 *
 * What IS generic is the credentials seam itself — a reference is any POSIX
 * identifier. So this command mounts the harness's own `LocalCredentialProvider`
 * and calls `set()`, which means the atomic write, the cross-process lock, the
 * `0600` mode, and the comment-preserving patch are all the harness's code
 * rather than our re-implementation of a file format we do not own.
 *
 * @module @upstash/agentkit-deepseek/cli
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  DEFAULT_TOKEN_REF,
  DEFAULT_URL_REF,
  assertCredentialRef,
  type CredentialWriter,
} from "./credentials.js";

/** Exit code for a usage error, matching the harness's own convention. */
const USAGE_EXIT = 1;

/** Parsed command line. */
interface Args {
  command: "set" | "status" | "help";
  url?: string;
  token?: string;
  home?: string;
  urlRef: string;
  tokenRef: string;
}

const HELP = `agentkit-deepseek — manage the Upstash credentials the DeepSeek Harness backend reads

Usage:
  agentkit-deepseek credentials set     [--url <url>] [--token <token>]
  agentkit-deepseek credentials status

Options:
  --url <url>          Upstash REST URL; prompted for when omitted
  --token <token>      Upstash REST token; prompted for when omitted
  --home <path>        Harness home (default: $DSH_HOME, else ~/.dsh)
  --url-ref <name>     Credential reference for the URL (default: ${DEFAULT_URL_REF})
  --token-ref <name>   Credential reference for the token (default: ${DEFAULT_TOKEN_REF})
  -h, --help           Show this help

Values are written to <home>/.credentials.yaml through the harness's own
credentials provider, which owns the file's atomic write and 0600 permissions.

Passing --token puts the secret in your shell history and process list; prefer
the interactive prompt, which does not echo.`;

/**
 * Parse argv.
 * @param argv - arguments after the node binary and script path.
 * @returns the parsed command.
 */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: "help", urlRef: DEFAULT_URL_REF, tokenRef: DEFAULT_TOKEN_REF };
  const rest = [...argv];

  // `credentials` is accepted as an optional noun so both `credentials set` and
  // a bare `set` work; the noun exists to leave room for later command groups.
  if (rest[0] === "credentials") rest.shift();

  const verb = rest.shift();
  if (verb === "set" || verb === "status") args.command = verb;
  else if (verb === undefined || verb === "-h" || verb === "--help" || verb === "help") {
    return args;
  } else {
    throw new Error(`unknown command "${verb}"`);
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${String(flag)} requires a value`);
      }
      i++;
      return value;
    };
    switch (flag) {
      case "--url":
        args.url = needsValue();
        break;
      case "--token":
        args.token = needsValue();
        break;
      case "--home":
        args.home = needsValue();
        break;
      case "--url-ref":
        args.urlRef = assertCredentialRef(needsValue());
        break;
      case "--token-ref":
        args.tokenRef = assertCredentialRef(needsValue());
        break;
      case "-h":
      case "--help":
        args.command = "help";
        break;
      default:
        throw new Error(`unknown option "${String(flag)}"`);
    }
  }

  return args;
}

/**
 * Load the harness packages this command drives.
 *
 * Imported dynamically, and deliberately not declared as runtime dependencies:
 * `@deepseek-ai/cordis` must stay a single copy (a second one would break
 * service identity), and the provider is only needed by this command, not by the
 * plugin. Both resolve from a profile directory through Node's parent walk,
 * which reaches the harness's maintained `$DSH_HOME/profiles/node_modules`
 * fallback.
 */
async function loadHarness() {
  try {
    const [{ Context }, provider] = await Promise.all([
      import("@deepseek-ai/cordis"),
      import("@deepseek-ai/dsh-credentials-local"),
    ]);
    return { Context, LocalCredentialProvider: provider.default };
  } catch (cause) {
    throw new Error(
      "cannot load the DeepSeek Harness credentials provider.\n" +
        "Run this from a directory where it resolves — a dsh profile is the usual one:\n" +
        "  dsh plugin --profile web exec agentkit-deepseek credentials set\n" +
        "or install it alongside this package:\n" +
        "  npm install @deepseek-ai/cordis @deepseek-ai/dsh-credentials-local",
      { cause },
    );
  }
}

/** Prompt for a value, hiding input for secrets. */
async function prompt(question: string, secret: boolean): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (!secret) return (await rl.question(question)).trim();
    // readline has no built-in masking: mute the echo callback for the duration
    // so the token never lands on screen (or in a scrollback buffer).
    const output = rl as unknown as { output?: { write(chunk: string): void } };
    const original = output.output?.write.bind(output.output);
    let muted = false;
    if (original !== undefined && output.output !== undefined) {
      output.output.write = (chunk: string) => {
        if (!muted) original(chunk);
      };
    }
    const answered = rl.question(question);
    muted = true;
    const value = await answered;
    muted = false;
    if (original !== undefined && output.output !== undefined) output.output.write = original;
    stdout.write("\n");
    return value.trim();
  } finally {
    rl.close();
  }
}

/**
 * Run the command.
 * @param argv - arguments after the node binary and script path.
 * @returns the process exit code.
 */
export async function run(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stdout.write(`${(error as Error).message}\n\n${HELP}\n`);
    return USAGE_EXIT;
  }

  if (args.command === "help") {
    stdout.write(`${HELP}\n`);
    return 0;
  }

  const { Context, LocalCredentialProvider } = await loadHarness();
  const ctx = new Context();
  // The provider watches its document, which keeps the event loop alive — so the
  // fiber is disposed before returning or this command would never exit.
  const fiber = await ctx.plugin(
    LocalCredentialProvider,
    args.home === undefined ? {} : { dshHome: args.home },
  );

  // Bound structurally: this package does not depend on `@deepseek-ai/dsh-credentials`,
  // so cordis's `Context` carries no `credentials` augmentation here.
  const credentials = ctx.get("credentials") as CredentialWriter;

  try {
    if (args.command === "status") {
      for (const ref of [args.urlRef, args.tokenRef]) {
        const info = await credentials.describe(ref);
        const where = info.configured ? `configured (source: ${String(info.source)})` : "not set";
        const writable = info.writable ? "" : " [read-only here]";
        stdout.write(`${ref}: ${where}${writable}\n`);
      }
      return 0;
    }

    const url = args.url ?? (await prompt("Upstash REST URL: ", false));
    const token = args.token ?? (await prompt("Upstash REST token: ", true));
    if (url.length === 0 || token.length === 0) {
      stdout.write("both a URL and a token are required; nothing was written\n");
      return USAGE_EXIT;
    }

    await credentials.set(args.urlRef, url);
    await credentials.set(args.tokenRef, token);
    stdout.write(`stored ${args.urlRef} and ${args.tokenRef}\n`);
    stdout.write("restart dsh for a running harness to pick them up\n");
    return 0;
  } finally {
    await fiber.dispose();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(new URL(`file://${process.argv[1]}`).pathname);

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // The provider refuses to write a reference the launching shell already
      // exports, because the write would be shadowed by a higher layer. That
      // message names the fix, so surface it rather than a stack trace.
      stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = USAGE_EXIT;
    });
}
