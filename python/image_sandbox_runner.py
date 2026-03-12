import ast
import json
import os
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import matplotlib.patches as patches
from matplotlib.projections.polar import PolarAxes


FORBIDDEN_CALLS = {
    "__import__",
    "eval",
    "exec",
    "open",
    "compile",
    "input",
    "globals",
    "locals",
    "vars",
    "help",
    "breakpoint",
    "getattr",
    "setattr",
    "delattr",
}

FORBIDDEN_NAMES = {
    "builtins",
    "importlib",
    "os",
    "pathlib",
    "shutil",
    "socket",
    "subprocess",
    "sys",
}


def validate_code(source: str) -> None:
    tree = ast.parse(source, filename="sandbox_input.py")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            raise RuntimeError(
                "Imports are disabled in this sandbox. Use the preloaded plt, np, patches, and PolarAxes symbols."
            )
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise RuntimeError("Dunder attribute access is disabled in this sandbox.")
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            raise RuntimeError(f"Name '{node.id}' is not allowed in this sandbox.")
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in FORBIDDEN_CALLS:
                raise RuntimeError(
                    f"Call to '{func.id}' is not allowed in this sandbox."
                )


def main() -> None:
    code_path = Path(os.environ["IMAGE_SANDBOX_CODE_PATH"])
    output_dir = Path(os.environ["IMAGE_SANDBOX_OUTPUT_DIR"])
    output_format = os.environ.get("IMAGE_SANDBOX_OUTPUT_FORMAT", "png").lower()
    dpi = int(os.environ.get("IMAGE_SANDBOX_DPI", "200"))

    output_dir.mkdir(parents=True, exist_ok=True)
    source = code_path.read_text(encoding="utf-8")
    validate_code(source)

    saved_paths = []

    def save_image(name: str | None = None, fig=None) -> str:
        figure = fig if fig is not None else plt.gcf()
        if figure is None:
            raise RuntimeError("No matplotlib figure is available to save.")
        stem = (
            name or f"image-{len(saved_paths) + 1}"
        ).strip() or f"image-{len(saved_paths) + 1}"
        safe_stem = (
            "".join(
                ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in stem
            ).strip("-")
            or f"image-{len(saved_paths) + 1}"
        )
        target_path = output_dir / f"{safe_stem}.{output_format}"
        figure.savefig(target_path, dpi=dpi, bbox_inches="tight")
        saved_paths.append(target_path)
        return str(target_path)

    sandbox_globals = {
        "__builtins__": __builtins__,
        "plt": plt,
        "np": np,
        "patches": patches,
        "PolarAxes": PolarAxes,
        "save_image": save_image,
    }

    exec(compile(source, "sandbox_input.py", "exec"), sandbox_globals, sandbox_globals)

    if not saved_paths:
        if not plt.get_fignums():
            raise RuntimeError(
                "The code finished without creating a matplotlib figure. Create a figure with plt.figure() or plt.subplots()."
            )
        save_image("image")

    print(
        json.dumps(
            {
                "saved": [path.name for path in saved_paths],
            }
        )
    )


if __name__ == "__main__":
    main()
