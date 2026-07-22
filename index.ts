import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { ScopedModelPicker, type ScopedModelChoice } from "./model-picker.ts";
import {
  createAgentSession,
  CONFIG_DIR_NAME,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type WorkerStatus = "starting" | "busy" | "idle" | "failed" | "stopped";
type Worker = {
  id: string;
  task: string;
  status: WorkerStatus;
  createdAt: number;
  updatedAt: number;
  sessionFile?: string;
  model?: string;
  lastResult?: string;
  lastSteer?: string;
  session?: Awaited<ReturnType<typeof createAgentSession>>["session"];
};
type Config = {
  /** Model used by the parent Pi session. */
  orchestratorModel?: string;
  /** Model used for newly created worker sessions; omitted means the active parent model. */
  workerModel?: string;
  /** Whether orchestration features are active. Defaults to true. */
  active?: boolean;
  /** Explicit Pi model scope for this extension. Only these available models are shown in /orch-settings. */
  modelScope?: string[];
  maxWorkers?: number;
};

const STATE_TYPE = "pi-orch:state";
const ORCHESTRATION_TOOLS = ["spawn_worker", "steer_worker", "worker_status", "stop_worker"] as const;
const WORKER_PROMPT = `You are a persistent implementation worker. Work only on your assigned task in the current project. Use tools to inspect, edit, and test. Keep changes scoped. When finished, report: files changed, tests run, remaining risks, and a concise handoff. Do not delegate work or wait for another agent.`;
const ORCHESTRATOR_PROMPT = `You are the Pi Orchestrator. Prefer delegating implementation, investigation, and verification to persistent workers with spawn_worker, especially when work can run independently or in parallel. Keep your own turns focused on planning, routing, review, and synthesis while workers run. However, you retain all of your normal tools and MAY work directly when the user explicitly asks you to do the work yourself, when the task concerns the orchestrator/extension itself, or when direct work is clearly faster or safer. When a worker completes, verify and critique its evidence, then either accept it, steer that same worker, or perform an appropriate follow-up. Use steer_worker to preserve a worker's history. If the user writes @worker-id followed by feedback, it is routed directly to that worker.`;

function textFromSession(worker: Worker): string {
  const messages = worker.session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block: { type?: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("");
    if (text) return truncateTail(text, { maxBytes: 8_000, maxLines: 160 }).content;
  }
  return "Worker completed without a textual handoff.";
}

function configPath(cwd: string) {
  return join(cwd, CONFIG_DIR_NAME, "pi-orch.json");
}

function validModelId(value: unknown): value is string {
  // Provider/model IDs may themselves contain slashes after the first separator.
  return typeof value === "string" && /^[^/\s]+\/.+\S$/.test(value);
}

async function loadConfig(cwd: string): Promise<Config> {
  try {
    const value = JSON.parse(await readFile(configPath(cwd), "utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      active: value.active !== false,
      orchestratorModel: validModelId(value.orchestratorModel) ? value.orchestratorModel : undefined,
      workerModel: validModelId(value.workerModel) ? value.workerModel : undefined,
      modelScope: Array.isArray(value.modelScope)
        ? [...new Set(value.modelScope.filter(validModelId))]
        : undefined,
      maxWorkers: Number.isInteger(value.maxWorkers) && (value.maxWorkers as number) > 0
        ? value.maxWorkers as number
        : undefined,
    };
  } catch {
    return {};
  }
}

/** Atomically replace project config so interrupted writes cannot leave invalid JSON. */
async function saveConfig(cwd: string, config: Config): Promise<void> {
  const path = configPath(cwd);
  const directory = join(cwd, CONFIG_DIR_NAME);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    // rename removes the source on success; remove a partial temp file on failure.
    await unlink(temporary).catch(() => undefined);
  }
}

function modelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function findAvailableModel(id: string | undefined, ctx: ExtensionContext) {
  if (!id) return undefined;
  return ctx.modelRegistry.getAvailable().find((model) => modelId(model) === id);
}

function modelFor(config: Config, ctx: ExtensionContext) {
  // A hand-edited config can name a registry model that is no longer available
  // (for example after logout). Never pass that model to a new SDK session.
  return findAvailableModel(config.workerModel, ctx) ?? ctx.model;
}

type ModelScope = { ids: string[]; source: "pi-orch config" | "Pi --models" | "Pi enabledModels" | "current model" };

function cliModelPatterns(): string[] | undefined {
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--models") return process.argv[index + 1]?.split(",").map(value => value.trim()).filter(Boolean);
    if (argument.startsWith("--models=")) return argument.slice("--models=".length).split(",").map(value => value.trim()).filter(Boolean);
  }
  return undefined;
}

async function piEnabledModelPatterns(ctx: ExtensionContext): Promise<string[] | undefined> {
  // This mirrors SettingsManager: project settings override global settings for
  // arrays, but untrusted projects do not contribute project settings at all.
  const readPatterns = async (path: string) => {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { enabledModels?: unknown };
      return Array.isArray(value.enabledModels) && value.enabledModels.every(item => typeof item === "string")
        ? value.enabledModels as string[] : undefined;
    } catch { return undefined; }
  };
  const global = await readPatterns(join(getAgentDir(), "settings.json"));
  const project = ctx.isProjectTrusted()
    ? await readPatterns(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
    : undefined;
  return project ?? global;
}

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

function globMatches(value: string, pattern: string): boolean {
  // Pi uses minimatch. Model scopes normally use *, ?, and character classes;
  // retain minimatch's important slash behavior (* and ? do not cross a slash).
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === "*") {
      const globstar = pattern[i + 1] === "*";
      if (globstar) i++;
      expression += globstar ? ".*" : "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i + 1) {
        const contents = pattern.slice(i + 1, end);
        expression += `[${contents.startsWith("!") ? "^" : ""}${contents.startsWith("!") ? contents.slice(1) : contents}]`;
        i = end;
      } else expression += "\\[";
    } else {
      expression += character.replace(/[\\^$+?.()|{}]/g, "\\$&");
    }
  }
  try { return new RegExp(`${expression}$`, "i").test(value); } catch { return false; }
}

function modelForPattern(pattern: string, available: AvailableModel[]): AvailableModel | undefined {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return undefined;
  const canonical = available.filter(model => modelId(model).toLowerCase() === normalized);
  if (canonical.length === 1) return canonical[0];
  const slash = pattern.indexOf("/");
  if (slash >= 0) {
    const provider = pattern.slice(0, slash).trim().toLowerCase();
    const id = pattern.slice(slash + 1).trim().toLowerCase();
    const matches = available.filter(model => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id);
    if (matches.length === 1) return matches[0];
  }
  const exactId = available.filter(model => model.id.toLowerCase() === normalized);
  if (exactId.length === 1) return exactId[0];

  // This is Pi's non-glob fallback: select one fuzzy match, preferring aliases
  // over dated releases and then the lexicographically latest ID.
  const partial = available.filter(model => model.id.toLowerCase().includes(normalized) || model.name?.toLowerCase().includes(normalized));
  const aliases = partial.filter(model => !/-\d{8}$/.test(model.id) || model.id.endsWith("-latest"));
  return (aliases.length ? aliases : partial).sort((a, b) => b.id.localeCompare(a.id))[0];
}

function modelsForScopePattern(pattern: string, available: AvailableModel[]): AvailableModel[] {
  // Pi first resolves a literal pattern as a model (important for IDs containing
  // colons), then treats a valid final suffix as its thinking-level annotation.
  const hasGlob = /[*?[]/.test(pattern);
  if (!hasGlob) {
    const literal = modelForPattern(pattern, available);
    if (literal) return [literal];
    // Pi also falls back after an invalid colon suffix (with a warning). This
    // matters for model IDs with provider-specific colon annotations.
    const lastColon = pattern.lastIndexOf(":");
    return lastColon < 0 ? [] : modelsForScopePattern(pattern.slice(0, lastColon), available);
  }
  const base = pattern.replace(THINKING_SUFFIX, "");
  return available.filter(model => globMatches(modelId(model), base) || globMatches(model.id, base));
}

async function scopeFor(config: Config, ctx: ExtensionContext): Promise<ModelScope> {
  if (config.modelScope?.length) return { ids: config.modelScope, source: "pi-orch config" };
  const cli = cliModelPatterns();
  const persisted = cli === undefined ? await piEnabledModelPatterns(ctx) : undefined;
  const patterns = cli ?? persisted;
  const available = ctx.modelRegistry.getAvailable();
  if (patterns?.length) {
    const models: AvailableModel[] = [];
    for (const pattern of patterns) {
      for (const model of modelsForScopePattern(pattern, available)) {
        if (!models.some(existing => modelId(existing) === modelId(model))) models.push(model);
      }
    }
    return { ids: models.map(modelId), source: cli === undefined ? "Pi enabledModels" : "Pi --models" };
  }
  return { ids: ctx.model ? [modelId(ctx.model)] : [], source: "current model" };
}

async function scopedModelChoices(config: Config, ctx: ExtensionContext): Promise<ScopedModelChoice[]> {
  const scope = await scopeFor(config, ctx);
  const available = new Map(ctx.modelRegistry.getAvailable().map((model) => [modelId(model), model]));
  return scope.ids.flatMap((id) => {
    const model = available.get(id);
    return model ? [{ id, provider: model.provider, modelId: model.id, name: model.name || model.id }] : [];
  });
}

async function pickScopedModel(
  title: string,
  config: Config,
  ctx: ExtensionContext,
  options: { currentId?: string; allowInherit?: boolean } = {},
): Promise<string | undefined | null> {
  const choices = await scopedModelChoices(config, ctx);
  if (!choices.length) {
    ctx.ui.notify("No available models in pi-orch's scope (--models, enabledModels, or modelScope)", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined | null>((tui, theme, _keybindings, done) =>
    new ScopedModelPicker({ tui, theme, title, choices, currentId: options.currentId, allowInherit: options.allowInherit, onDone: done }),
  );
}

export default function piOrch(pi: ExtensionAPI) {
  const workers = new Map<string, Worker>();
  let closed = false;
  let sequence = 0;
  let active = true;
  let normalTools: string[] = [];

  const applyToolState = () => {
    // Preserve every tool owned by Pi or other extensions. pi-orch activation
    // controls only its own four worker tools.
    const orchestration = new Set<string>(ORCHESTRATION_TOOLS);
    normalTools = [...new Set([
      ...normalTools,
      ...pi.getActiveTools().filter(name => !orchestration.has(name)),
    ])];
    pi.setActiveTools(active
      ? [...new Set([...normalTools, ...ORCHESTRATION_TOOLS])]
      : normalTools);
  };

  const persist = () => {
    pi.appendEntry(STATE_TYPE, {
      workers: [...workers.values()].map(({ session, ...worker }) => worker),
      sequence,
    });
  };

  const render = (ctx: ExtensionContext) => {
    if (!active) {
      ctx.ui.setWidget("pi-orch:workers", undefined);
      ctx.ui.setStatus("pi-orch", undefined);
      return;
    }
    const rows = [...workers.values()].map((worker) => {
      const age = Math.round((Date.now() - worker.createdAt) / 1000);
      return `${worker.id.padEnd(4)} ${worker.status.padEnd(8)} ${String(age).padStart(4)}s  ${worker.task.replace(/\s+/g, " ").slice(0, 72)}`;
    });
    const activeWorkers = [...workers.values()].filter(worker => worker.status === "busy" || worker.status === "starting").length;
    // Keep both the dashboard and its summary below the composer. Putting the
    // summary in the widget (rather than the footer) makes the whole dashboard
    // available together when Pi's below-editor area is revealed.
    const dashboard = rows.length
      ? ["Workers", `${activeWorkers} working / ${rows.length} workers`, ...rows]
      : undefined;
    ctx.ui.setWidget("pi-orch:workers", dashboard, { placement: "belowEditor" });
    ctx.ui.setStatus("pi-orch", undefined);
  };

  const workerLoader = async (cwd: string) => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true, // Never recursively load this orchestrator into workers.
      systemPromptOverride: (base) => `${base ?? ""}\n\n${WORKER_PROMPT}`,
    });
    await loader.reload();
    return loader;
  };

  const ensureSession = async (worker: Worker, ctx: ExtensionContext) => {
    if (worker.session) return worker.session;
    const config = await loadConfig(ctx.cwd);
    const sessionManager = worker.sessionFile ? SessionManager.open(worker.sessionFile) : SessionManager.create(ctx.cwd);
    const result = await createAgentSession({
      cwd: ctx.cwd,
      model: modelFor(config, ctx),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader: await workerLoader(ctx.cwd),
      sessionManager,
    });
    worker.session = result.session;
    worker.sessionFile = result.session.sessionFile;
    return result.session;
  };

  const notifyCompletion = (worker: Worker) => {
    if (closed || !active) return;
    pi.sendMessage({
      customType: "pi-orch:worker-complete",
      content: `[Worker ${worker.id} ${worker.status}] Task: ${worker.task}\n\nHandoff:\n${worker.lastResult ?? "No handoff."}\n\nReview this evidence and choose whether to delegate or perform any follow-up directly.`, 
      display: true,
      details: { workerId: worker.id, status: worker.status },
    }, { deliverAs: "followUp", triggerTurn: true });
  };

  const run = async (worker: Worker, instruction: string, ctx: ExtensionContext, isNew: boolean) => {
    const session = await ensureSession(worker, ctx);
    worker.status = "busy";
    worker.updatedAt = Date.now();
    persist(); render(ctx);
    try {
      if (isNew) await session.prompt(instruction);
      else if (session.isStreaming) await session.steer(instruction);
      else await session.prompt(instruction);
      worker.status = "idle";
      worker.lastResult = textFromSession(worker);
    } catch (error) {
      // stop_worker deliberately aborts the SDK turn; it is not a failed task.
      if ((worker.status as WorkerStatus) !== "stopped") worker.status = "failed";
      worker.lastResult = error instanceof Error ? error.message : String(error);
    }
    worker.updatedAt = Date.now();
    persist(); render(ctx); notifyCompletion(worker);
  };

  pi.on("session_start", async (_event, ctx) => {
    workers.clear(); sequence = 0; closed = false;
    active = (await loadConfig(ctx.cwd)).active !== false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as { workers?: Worker[]; sequence?: number };
      workers.clear();
      for (const worker of data.workers ?? []) {
        // A process restart cannot preserve an in-flight SDK call. Keep its history,
        // but make the worker explicitly resumable rather than falsely "busy".
        const status = worker.status === "busy" || worker.status === "starting" ? "stopped" : worker.status;
        workers.set(worker.id, { ...worker, status, session: undefined });
      }
      sequence = data.sequence ?? sequence;
    }
    // Apply the project-selected parent model after session restoration. A missing or
    // unauthenticated model never prevents Pi from starting with its current model.
    const config = await loadConfig(ctx.cwd);
    const configuredParent = active ? findAvailableModel(config.orchestratorModel, ctx) : undefined;
    if (active && config.orchestratorModel && !configuredParent) {
      ctx.ui.notify(`pi-orch parent model is unavailable: ${config.orchestratorModel}`, "warning");
    } else if (configuredParent && modelId(configuredParent) !== (ctx.model ? modelId(ctx.model) : "")) {
      if (!await pi.setModel(configuredParent)) {
        ctx.ui.notify(`pi-orch cannot authenticate parent model: ${config.orchestratorModel}`, "warning");
      }
    }
    // Activation adds/removes only pi-orch's tools. The parent always retains
    // its normal coding tools and can work directly when appropriate.
    applyToolState();
    render(ctx);
  });

  pi.on("before_agent_start", (event) => active
    ? ({ systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` })
    : undefined);

  pi.on("input", async (event, ctx) => {
    if (!active) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    const match = event.text.match(/^@([\w-]+)\s+([\s\S]+)/);
    if (!match) return { action: "continue" };
    const worker = workers.get(match[1]);
    if (!worker) {
      ctx.ui.notify(`Unknown worker: ${match[1]}`, "warning");
      return { action: "handled" };
    }
    worker.lastSteer = match[2];
    void run(worker, `User feedback: ${match[2]}`, ctx, false);
    ctx.ui.notify(`Sent feedback to ${worker.id}`, "info");
    return { action: "handled" };
  });

  pi.registerTool({
    name: "spawn_worker", label: "Spawn Worker",
    description: "Start a persistent coding worker asynchronously. Returns immediately so the parent can wait, coordinate other workers, or continue suitable direct work.",
    promptSnippet: "Delegate an implementation task to a persistent worker",
    parameters: Type.Object({ task: Type.String({ minLength: 1 }), label: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!active) throw new Error("pi-orch is deactivated; use /orch-settings to activate it");
      const config = await loadConfig(ctx.cwd);
      const limit = config.maxWorkers ?? 4;
      if (workers.size >= limit) throw new Error(`Worker limit reached (${limit}). Reuse an existing worker.`);
      const id = (params.label?.replace(/[^\w-]/g, "").slice(0, 16) || `w${++sequence}`);
      if (workers.has(id)) throw new Error(`Worker ${id} already exists.`);
      const worker: Worker = { id, task: params.task, status: "starting", createdAt: Date.now(), updatedAt: Date.now() };
      workers.set(id, worker); persist(); render(ctx);
      void run(worker, `Assigned task:\n${params.task}`, ctx, true);
      return { content: [{ type: "text", text: `Worker ${id} started asynchronously. You may wait for it or continue appropriate direct work in parallel.` }], details: { workerId: id }, terminate: true };
    },
  });

  pi.registerTool({
    name: "steer_worker", label: "Steer Worker",
    description: "Send critique, feedback, or a follow-up task to a persistent worker while preserving its full session history.",
    parameters: Type.Object({ workerId: Type.String(), feedback: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!active) throw new Error("pi-orch is deactivated; use /orch-settings to activate it");
      const worker = workers.get(params.workerId);
      if (!worker) throw new Error(`Unknown worker: ${params.workerId}`);
      worker.lastSteer = params.feedback;
      void run(worker, `Orchestrator feedback: ${params.feedback}`, ctx, false);
      return { content: [{ type: "text", text: `Feedback sent to ${worker.id}; it will report again when complete.` }], details: { workerId: worker.id }, terminate: true };
    },
  });

  pi.registerTool({
    name: "worker_status", label: "Worker Status", description: "List all workers and their current state.", parameters: Type.Object({}),
    async execute() {
      if (!active) throw new Error("pi-orch is deactivated; use /orch-settings to activate it");
      const text = [...workers.values()].map(w => `${w.id}: ${w.status} — ${w.task}`).join("\n") || "No workers.";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "stop_worker", label: "Stop Worker", description: "Abort a worker's current turn while retaining its persistent session for later feedback.", parameters: Type.Object({ workerId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!active) throw new Error("pi-orch is deactivated; use /orch-settings to activate it");
      const worker = workers.get(params.workerId);
      if (!worker) throw new Error(`Unknown worker: ${params.workerId}`);
      await worker.session?.abort();
      worker.status = "stopped"; worker.updatedAt = Date.now(); persist(); render(ctx);
      return { content: [{ type: "text", text: `Stopped ${worker.id}; its session is retained.` }], details: {} };
    },
  });

  pi.registerCommand("orch-settings", {
    description: "Configure pi-orch activation, parent, and worker models for this project",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/orch-settings requires Pi's interactive UI", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before saving pi-orch settings", "warning");
        return;
      }

      let config = await loadConfig(ctx.cwd);
      while (true) {
        const parent = config.orchestratorModel ?? (ctx.model ? modelId(ctx.model) : "no active model");
        const worker = config.workerModel ?? "use orchestrator model";
        const action = await ctx.ui.select("pi-orch settings", [
          config.active === false ? "Status: Deactivated" : "Status: Active",
          `Set parent / orchestrator: ${parent}`,
          `Set worker / coding: ${worker}`,
        ]);
        if (!action) return;

        if (action === "Status: Active" || action === "Status: Deactivated") {
          const nextActive = action === "Status: Deactivated";
          if (!nextActive) {
            // Preserve idle sessions, but abort in-flight turns before disabling all
            // worker tools so no worker continues mutating the tree unnoticed.
            for (const worker of workers.values()) {
              if (worker.status === "busy" || worker.status === "starting") {
                await worker.session?.abort();
                worker.status = "stopped";
                worker.updatedAt = Date.now();
              }
            }
          }
          active = nextActive;
          config = { ...config, active };
          // Apply the runtime gate before disk I/O: the toggle must take effect
          // immediately even if the project config cannot be written.
          applyToolState();
          persist();
          render(ctx);
          try {
            await saveConfig(ctx.cwd, config);
            if (active && config.orchestratorModel) {
              const configured = findAvailableModel(config.orchestratorModel, ctx);
              if (!configured || !await pi.setModel(configured)) {
                ctx.ui.notify(`pi-orch activated, but parent model is unavailable: ${config.orchestratorModel}`, "warning");
              }
            }
            ctx.ui.notify(active ? "pi-orch activated" : "pi-orch deactivated; busy workers stopped and idle sessions retained", "info");
          } catch (error) {
            ctx.ui.notify(`pi-orch activation changed in memory but was not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        } else if (action.startsWith("Set parent / orchestrator")) {
          const selected = await pickScopedModel("Select pi-orch orchestrator model", config, ctx, {
            currentId: config.orchestratorModel ?? (ctx.model ? modelId(ctx.model) : undefined),
          });
          if (!selected) continue;
          const model = findAvailableModel(selected, ctx);
          if (!model || (active && !await pi.setModel(model))) {
            ctx.ui.notify(`Could not configure ${selected}; check its authentication`, "error");
            continue;
          }
          config = { ...config, orchestratorModel: selected };
          try {
            await saveConfig(ctx.cwd, config);
            ctx.ui.notify(`pi-orch parent model: ${selected}`, "info");
          } catch (error) {
            ctx.ui.notify(`Parent model changed but configuration was not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        } else {
          const selected = await pickScopedModel("Select pi-orch worker model", config, ctx, {
            currentId: config.workerModel,
            allowInherit: true,
          });
          if (selected === null) continue;
          // undefined is the explicit "Use orchestrator model" row; null is cancel.
          config = { ...config, workerModel: selected };
          try {
            await saveConfig(ctx.cwd, config);
            ctx.ui.notify(selected ? `pi-orch worker model: ${selected}` : "pi-orch workers will use the active parent model", "info");
          } catch (error) {
            ctx.ui.notify(`Worker model configuration was not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        }
      }
    },
  });

  pi.registerCommand("workers", {
    description: "Show persistent orchestration workers",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("pi-orch is deactivated; use /orch-settings to activate it", "warning");
        return;
      }
      const text = [...workers.values()].map(w => `${w.id}  ${w.status}  ${w.task}`).join("\n") || "No workers.";
      ctx.ui.notify(text, "info"); render(ctx);
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    closed = true; persist();
    for (const worker of workers.values()) worker.session?.dispose();
    render(ctx);
  });
}
