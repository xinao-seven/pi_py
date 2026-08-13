import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { ApiError } from "../errors.js";

const execFile = promisify(execFileCallback);

/** Opens Windows' native folder dialog only after an explicit UI request. */
export async function chooseDirectory(): Promise<string | undefined> {
  if (process.platform !== "win32") {
    throw new ApiError(501, "directory_picker_unavailable", "Native directory picker is currently available on Windows only");
  }
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择项目文件夹'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
    "$dialog.Dispose()",
  ].join("; ");
  try {
    const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-Sta", "-Command", script], {
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch (error) {
    throw new ApiError(503, "directory_picker_unavailable", "Native directory picker is unavailable", String(error));
  }
}
