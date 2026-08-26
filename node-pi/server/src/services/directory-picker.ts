/**
 * Windows 原生"选择文件夹"对话框。
 *
 * 中文说明：Node 没有内置目录选择能力，这里通过调用 PowerShell 弹
 * System.Windows.Forms 的 FolderBrowserDialog（仅 Windows 可用）。
 * 只在用户显式点击"选择目录"时才调用，绝不自动弹出。
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { ApiError } from '../errors.js';

// promisify 把 child_process.execFile 回调风格转成 Promise 风格。
const execFile = promisify(execFileCallback);

/** 弹出系统文件夹选择框，返回用户选中的绝对路径；用户取消时返回 undefined。 */
export async function chooseDirectory(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    throw new ApiError(
      501,
      'directory_picker_unavailable',
      'Native directory picker is currently available on Windows only',
    );
  }
  // PowerShell 脚本：创建 FolderBrowserDialog，把选中的路径写到 stdout。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择项目文件夹'",
    '$dialog.ShowNewFolderButton = $false', // 不允许在对话框里新建文件夹
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    '$dialog.Dispose()',
  ].join('; ');
  try {
    // -Sta：WinForms 对话框要求单线程单元（STA）线程；
    // -NoProfile：跳过用户配置文件，启动更快更干净；
    // windowsHide: true：不弹出黑色命令行窗口。
    const { stdout } = await execFile(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-Command', script],
      {
        windowsHide: true,
      },
    );
    // 用户取消时 stdout 为空 → 返回 undefined。
    return stdout.trim() || undefined;
  } catch (error) {
    throw new ApiError(
      503,
      'directory_picker_unavailable',
      'Native directory picker is unavailable',
      String(error),
    );
  }
}
