// claude2's Re-Auth (loginToAnthropic, runLoginFlow), split into steps the page can drive. "claude
// auth login" needs no TTY: it prints the sign-in URL on stdout and reads the one-time code on
// stdin, and that URL's redirect ends on an Anthropic-hosted page showing the code (never
// localhost), so the same flow works on every host. Turns already running are unaffected; each
// turn spawns a fresh CLI process that re-reads the credentials file.
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { childEnv, collectProcess } from "./claudeCli.ts";

interface LoginResult {
  done: boolean;
  account: string;
  error: string;
}
interface Login {
  child: ChildProcessWithoutNullStreams;
  result: LoginResult;
  // What the CLI has printed since the code went in, for the error when it never finishes.
  said: string;
  log: (line: string) => void;
}

// One sign-in at a time on this host; nothing but the next one or its Cancel ends one left open.
let login: Login | null = null;

function finish(state: Login, error: string, account = ""): void {
  if (!state.result.done) {
    state.result = { done: true, account, error };
    state.log(`login result: ${error || account}`);
  }
}

async function signedInAccount(cwd: string): Promise<string> {
  const status = JSON.parse(await collectProcess("claude", ["auth", "status"], cwd, 15000, null)) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
  if (status.loggedIn !== true) {
    throw new Error("claude auth status still reports logged out.");
  }
  return `${status.email ?? "unknown account"} (${status.subscriptionType ?? "unknown"} plan)`;
}

// Resolves to the sign-in URL. The page then polls loginResult, which also ends when no code is
// needed: the CLI opens a browser of its own where it can, and approving there finishes it.
export function startLogin(cwd: string, onSignedIn: () => void, log: (line: string) => void): Promise<string> {
  cancelLogin();
  // DEBUG makes the CLI keep its own log of the sign-in in ~/.claude/debug/, which is where a
  // stuck one shows what it was waiting on. Everything it prints goes to the backend's log too.
  const child = spawn("claude", ["auth", "login"], { cwd, env: { ...childEnv(), DEBUG: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const state: Login = { child, result: { done: false, account: "", error: "" }, said: "", log };
  login = state;
  log(`login: started, pid ${child.pid ?? "none"}`);
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutText = "";
  let stderrText = "";
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
    stream.on("data", (chunk: string) => {
      state.said += chunk;
      log(`login ${name}: ${JSON.stringify(chunk)}`);
    });
  }
  child.on("error", (error) => finish(state, error.message));
  // exit is the process ending, close that and its pipes shut: a gap between them is a child of the CLI holding a pipe.
  child.on("exit", (exitCode, signal) => log(`login: exit, code ${exitCode ?? "none"}, signal ${signal ?? "none"}`));
  child.on("close", (exitCode) => {
    log(`login: closed, code ${exitCode ?? "none"}`);
    if (exitCode !== 0) {
      finish(state, stderrText.trim() || `claude auth login exited with code ${exitCode ?? "unknown"}.`);
      return;
    }
    signedInAccount(cwd).then(
      (account) => {
        onSignedIn();
        finish(state, "", account);
      },
      (error: Error) => finish(state, error.message),
    );
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The claude CLI did not print a sign-in URL within 30 seconds."));
    }, 30000);
    child.stdout.on("data", (chunk: string) => {
      stdoutText += chunk;
      // Up to the white space after it: a chunk can end inside the URL.
      const match = stdoutText.match(/https:\/\/\S+(?=\s)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      reject(new Error(stderrText.trim() || "The claude CLI exited before printing a sign-in URL."));
    });
  });
}

export function sendLoginCode(code: string): void {
  const state = login;
  if (!state || state.result.done) {
    throw new Error("No sign-in is in progress.");
  }
  state.said = "";
  state.log(`login: code sent, ${code.length} characters`);
  state.child.stdin.write(code + "\n");
  state.child.stdin.end();
  // Two minutes, not 30 seconds: stopping it mid-way may leave the host signed out, and a slow finish is still a finish.
  const timeout = setTimeout(() => {
    finish(state, `The claude CLI did not finish within 2 minutes of the code being entered. It printed: ${state.said.trim() || "nothing"}`);
    state.child.kill("SIGTERM");
  }, 120000);
  state.child.on("close", () => clearTimeout(timeout));
}

export function loginResult(): LoginResult {
  return login?.result ?? { done: true, account: "", error: "No sign-in is in progress." };
}

export function cancelLogin(): void {
  login?.child.kill("SIGTERM");
  login = null;
}
