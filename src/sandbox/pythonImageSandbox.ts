import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SandboxStatus = {
  available: boolean;
  command: string;
  details: string;
};

export type RenderedSandboxImage = {
  fileName: string;
  mimeType: string;
  byteLength: number;
  createdAt: string;
  publicUrl: string;
  resourceUri: string;
};

type RenderResult = {
  saved: string[];
};

const RESOURCE_TEMPLATE = "mcp-social-publisher://sandbox-images/{fileName}";
const GUIDE_URI = "mcp-social-publisher://guides/image-workflow";
const MAX_CODE_SIZE = 24_000;
const MAX_STDERR = 8_000;
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

export class PythonImageSandbox {
  private readonly baseDir: string;
  private readonly imageDir: string;
  private readonly runDir: string;
  private readonly runnerPath: string;
  private readonly projectRoot: string;
  private readonly setupScriptPath: string;
  private status: SandboxStatus = {
    available: false,
    command: "python3",
    details: "not checked",
  };

  public constructor(
    private readonly publicBaseUrl: URL,
    baseDir: string,
  ) {
    this.baseDir = path.resolve(baseDir);
    this.projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    this.imageDir = path.join(this.baseDir, "sandbox-images");
    this.runDir = path.join(this.baseDir, "sandbox-runs");
    this.runnerPath = path.join(this.projectRoot, "python", "image_sandbox_runner.py");
    this.setupScriptPath = path.join(this.projectRoot, "scripts", "setup-python-sandbox.mjs");
  }

  public async init(): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
    await mkdir(this.runDir, { recursive: true });
    await this.cleanup();
    this.status = await this.detect();
    if (!this.status.available) {
      const bootstrapError = await this.bootstrap();
      if (bootstrapError) {
        this.status = {
          ...this.status,
          details: `bootstrap failed: ${bootstrapError}`,
        };
        return;
      }
      this.status = await this.detect();
    }
  }

  public getStatus(): SandboxStatus {
    return this.status;
  }

  public getGuideUri(): string {
    return GUIDE_URI;
  }

  public getResourceTemplate(): string {
    return RESOURCE_TEMPLATE;
  }

  public createGuideMarkdown(): string {
    return [
      "# Bluesky image workflow",
      "",
      "Use `publisher_render_python_image` to generate a temporary PNG on the MCP server, then pass the returned `publicUrl` into `publisher_publish_bluesky` with `encoding: \"url\"`.",
      "",
      "## Preloaded Python symbols",
      "",
      "- `plt` -> `matplotlib.pyplot`",
      "- `np` -> `numpy`",
      "- `patches` -> `matplotlib.patches`",
      "- `PolarAxes` -> `matplotlib.projections.polar.PolarAxes`",
      "- `save_image(name=None, fig=None)` -> saves the current figure as a PNG",
      "",
      "Imports are disabled inside the sandbox. Use the preloaded names directly.",
      "",
      "## Minimal example",
      "",
      "```python",
      "fig, ax = plt.subplots(figsize=(8, 5))",
      "x = np.linspace(0, 2 * np.pi, 400)",
      "ax.plot(x, np.sin(x), linewidth=3)",
      "ax.set_title('Sine wave')",
      "ax.set_xlabel('x')",
      "ax.set_ylabel('sin(x)')",
      "```",
      "",
      "If you do not call `save_image(...)`, the sandbox saves the current matplotlib figure automatically.",
      "",
      "## Publish example",
      "",
      "```json",
      "{",
      "  \"target\": \"default-bluesky\",",
      "  \"text\": \"Chart update\",",
      "  \"images\": [",
      "    {",
      "      \"data\": \"https://mcp-social-publisher-live.onrender.com/sandbox-images/<fileName>\",",
      "      \"encoding\": \"url\",",
      "      \"alt\": \"Short description of the chart\"",
      "    }",
      "  ]",
      "}",
      "```",
    ].join("\n");
  }

  public async render(code: string): Promise<RenderedSandboxImage[]> {
    if (!this.status.available) {
      throw new Error(`Python image sandbox is unavailable: ${this.status.details}`);
    }
    if (code.length > MAX_CODE_SIZE) {
      throw new Error(`Python image code exceeds ${MAX_CODE_SIZE} characters`);
    }

    await this.cleanup();

    const runId = randomUUID();
    const workingDir = path.join(this.runDir, runId);
    const codePath = path.join(workingDir, "sandbox_input.py");
    await mkdir(workingDir, { recursive: true });
    await writeFile(codePath, code, "utf8");

    try {
      const result = await this.executeRunner(codePath, workingDir);
      const rendered: RenderedSandboxImage[] = [];

      for (const savedName of result.saved) {
        const sourcePath = path.join(workingDir, savedName);
        const buffer = await readFile(sourcePath);
        const extension = path.extname(savedName).toLowerCase() || ".png";
        const fileName = `${randomUUID()}${extension}`;
        const destinationPath = path.join(this.imageDir, fileName);
        await writeFile(destinationPath, buffer);
        rendered.push({
          fileName,
          mimeType: mimeTypeForExtension(extension),
          byteLength: buffer.byteLength,
          createdAt: new Date().toISOString(),
          publicUrl: new URL(`/sandbox-images/${encodeURIComponent(fileName)}`, this.publicBaseUrl).toString(),
          resourceUri: `mcp-social-publisher://sandbox-images/${encodeURIComponent(fileName)}`,
        });
      }

      return rendered;
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  }

  public async readImage(fileName: string): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
    if (!isSafeFileName(fileName)) {
      return undefined;
    }
    const filePath = path.join(this.imageDir, fileName);
    try {
      const buffer = await readFile(filePath);
      return {
        buffer,
        mimeType: mimeTypeForExtension(path.extname(fileName).toLowerCase()),
      };
    } catch {
      return undefined;
    }
  }

  public async cleanup(): Promise<void> {
    await cleanupDirectory(this.imageDir, IMAGE_TTL_MS);
    await cleanupDirectory(this.runDir, 10 * 60 * 1000);
  }

  private async detect(): Promise<SandboxStatus> {
    for (const candidate of this.pythonCandidates()) {
      const result = await runProcess(candidate, ["-c", "import matplotlib, numpy; print('ok')"], this.baseDir, 15_000);
      if (result.code === 0 && result.stdout.trim().endsWith("ok")) {
        return {
          available: true,
          command: candidate,
          details: "matplotlib and numpy ready",
        };
      }
    }

    return {
      available: false,
      command: this.pythonCandidates()[0] ?? "python3",
      details: "python3 with matplotlib and numpy is missing",
    };
  }

  private async bootstrap(): Promise<string | undefined> {
    const result = await runProcess(process.execPath, [this.setupScriptPath], this.projectRoot, 10 * 60 * 1000, {
      SKIP_PYTHON_SANDBOX_SETUP: "0",
    });
    if (result.code === 0) {
      return undefined;
    }
    return (result.stderr.trim() || result.stdout.trim() || "unknown bootstrap failure").slice(-MAX_STDERR);
  }

  private pythonCandidates(): string[] {
    return [
      path.join(this.projectRoot, ".python-sandbox", "bin", "python"),
      "python3",
    ];
  }

  private async executeRunner(codePath: string, workingDir: string): Promise<RenderResult> {
    const result = await runProcess(
      this.status.command,
      [this.runnerPath],
      this.baseDir,
      30_000,
      {
        IMAGE_SANDBOX_CODE_PATH: codePath,
        IMAGE_SANDBOX_OUTPUT_DIR: workingDir,
        IMAGE_SANDBOX_OUTPUT_FORMAT: "png",
        IMAGE_SANDBOX_DPI: "200",
        MPLBACKEND: "Agg",
        PYTHONNOUSERSITE: "1",
      },
    );

    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || "Python image sandbox failed";
      throw new Error(message.slice(-MAX_STDERR));
    }

    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) {
      throw new Error("Python image sandbox did not return a render result");
    }
    return JSON.parse(lastLine) as RenderResult;
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_STDERR) {
        stderr = stderr.slice(-MAX_STDERR);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: error.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function cleanupDirectory(directory: string, maxAgeMs: number): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      const metadata = await stat(fullPath).catch(() => undefined);
      if (!metadata) {
        return;
      }
      if (Date.now() - metadata.mtimeMs <= maxAgeMs) {
        return;
      }
      await rm(fullPath, { recursive: entry.isDirectory(), force: true });
    }));
  } catch {
    // ignore cleanup failures
  }
}

function isSafeFileName(value: string): boolean {
  return /^[a-f0-9-]+\.(png|jpg|jpeg|webp)$/i.test(value);
}

function mimeTypeForExtension(extension: string): string {
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}
