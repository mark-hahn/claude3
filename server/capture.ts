// claude2's capture.ts: a shot of the Windows desktop, as a PNG data URI. On the WSL backend it
// crosses interop to the same PowerShell the Windows backend runs directly. The srv backend can't
// see the screen, so the page asks a laptop backend for the shot whichever host the tab is on.
// hideWindow minimizes the window that asked (the page's) for the length of the shot, for a
// picture of what it was covering.
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const PNG_DATA_URI = "data:image/png;base64,";

export async function captureScreen(hideWindow: boolean): Promise<string> {
  const name = `claude3-cap-${randomUUID()}.png`;
  const windows = process.platform === "win32";
  // PowerShell writes on the Windows side of the mount; the same file reads back through /mnt/c.
  const local = windows ? path.join(os.tmpdir(), name) : `/mnt/c/Windows/Temp/${name}`;
  await runPowershell(windows ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", windows ? local : `C:\\Windows\\Temp\\${name}`, hideWindow);
  const png = await fs.promises.readFile(local);
  await fs.promises.rm(local, { force: true }).catch(() => undefined);
  return PNG_DATA_URI + png.toString("base64");
}

// How long the desktop gets to itself once the window is minimized: the minimize animation has to
// finish and whatever was behind it has to repaint before the screen is worth copying.
const hideSettleMs = 700;
// ShowWindow commands, from winuser.h.
const swMinimize = 6;
const swRestore = 9;

// user32 is doing three unrelated jobs here, so one interop class carries all of them: DPI
// awareness for the capture, and minimize/restore for hiding the window that asked for it.
const winApi =
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Claude3Win { " +
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); ' +
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); ' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e); }\'';

function captureScript(target: string, hideWindow: boolean): string[] {
  const shot = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ];
  // Without DPI awareness Windows reports the screen in scaled (logical) pixels: at 150% scale
  // that captured only the top-left two thirds of the desktop. Must run before any screen metric
  // is read.
  const lines = [winApi, "[void][Claude3Win]::SetProcessDPIAware()"];
  if (!hideWindow) {
    return [...lines, ...shot];
  }
  // The foreground window is the one the user just clicked Cap in. Restoring happens in a finally
  // so a capture that throws still gives the window back. Once minimized, the window behind it
  // owns the foreground, and Windows refuses SetForegroundWindow from a process that isn't the
  // foreground one. A process that sent the last input event is exempt, hence an empty mouse event.
  return [
    ...lines,
    "$hwnd = [Claude3Win]::GetForegroundWindow()",
    `[void][Claude3Win]::ShowWindow($hwnd, ${swMinimize})`,
    `try { Start-Sleep -Milliseconds ${hideSettleMs}; ${shot.join("; ")} } ` +
      `finally { [void][Claude3Win]::ShowWindow($hwnd, ${swRestore}); [Claude3Win]::mouse_event(0, 0, 0, 0, [UIntPtr]::Zero); [void][Claude3Win]::SetForegroundWindow($hwnd) }`,
  ];
}

function runPowershell(exe: string, target: string, hideWindow: boolean): Promise<void> {
  const script = captureScript(target, hideWindow).join("; ");
  return new Promise((resolve, reject) => {
    execFile(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve();
      }
    });
  });
}
