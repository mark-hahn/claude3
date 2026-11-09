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
}

// One sign-in at a time on this host; nothing but the next one or its Cancel ends one left open.
let login: Login | null = null;

function finish(state: Login, error: string, account = ""): void {
  if (!state.result.done) {
    state.result = { done: true, account, error };
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
export function startLogin(cwd: string, onSignedIn: () => void): Promise<string> {
  cancelLogin();
  const child = spawn("claude", ["auth", "login"], { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const state: Login = { child, result: { done: false, account: "", error: "" } };
  login = state;
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutText = "";
  let stderrText = "";
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  child.on("error", (error) => finish(state, error.message));
  child.on("close", (exitCode) => {
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
  state.child.stdin.write(code + "\n");
  state.child.stdin.end();
  const timeout = setTimeout(() => {
    finish(state, "The claude CLI did not finish within 30 seconds of the code being entered.");
    state.child.kill("SIGTERM");
  }, 30000);
  state.child.on("close", () => clearTimeout(timeout));
}

export function loginResult(): LoginResult {
  return login?.result ?? { done: true, account: "", error: "No sign-in is in progress." };
}

export function cancelLogin(): void {
  login?.child.kill("SIGTERM");
  login = null;
}
