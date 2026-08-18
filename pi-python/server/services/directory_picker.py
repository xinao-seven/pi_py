"""Native local directory picker used only after an explicit Web UI request."""

from __future__ import annotations


def choose_directory() -> str | None:
    """Show the operating system folder chooser and return a selected path.

    Browsers intentionally do not disclose absolute local paths to web pages.
    This small local-server bridge is therefore invoked only by the user's
    explicit "Choose folder" action in the project switcher.
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            selected = filedialog.askdirectory(parent=root, title="选择项目文件夹")
        finally:
            root.destroy()
    except Exception as exception:  # GUI availability depends on the local host.
        raise RuntimeError("Native directory picker is unavailable") from exception
    return selected or None
