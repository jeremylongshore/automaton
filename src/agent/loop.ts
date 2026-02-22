/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
} from "../types.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import {
  getEconomicsSnapshot,
  getRunwayTier,
  recordTurnCost,
  shouldSleep as economicsShouldSleep,
} from "../survival/economics.js";
import { ulid } from "ulid";

const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_TURNS_PER_WAKE = 20;

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, onStateChange, onTurnComplete } =
    options;

  const tools = createBuiltinTools(identity.sandboxId);
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;
  let turnsThisWake = 0;
  let lastToolName = "";
  let consecutiveSameTool = 0;

  // Track status tools called this wake — block repeats to prevent loops
  const ONCE_PER_WAKE_TOOLS = new Set([
    "check_economics", "check_credits", "scan_landscape",
    "heartbeat_ping", "check_health",
  ]);
  const calledOnceTools = new Set<string>();

  // Track exec commands to block identical retries within a wake cycle
  const executedCommands = new Set<string>();

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state — bypass Conway credits when using OpenAI directly
  let financial: FinancialState;
  if (process.env.OPENAI_API_KEY) {
    financial = { creditsCents: 99999, usdcBalance: 0, lastChecked: new Date().toISOString() };
  } else {
    financial = await getFinancialState(conway, identity.address);
  }

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  // Clear any stale sleep timer — we're awake now
  db.setKV("sleep_until", "");

  log(config, `[WAKE UP] ${config.name} is alive. Credits: $${(financial.creditsCents / 100).toFixed(2)}`);

  // ─── Bootstrap Phase ─────────────────────────────────────────
  // Run a fixed sequence of tools WITHOUT going through inference.
  // This gives the model real context about the environment so it
  // can make productive decisions instead of looping on status checks.

  const bootstrapResults: string[] = [];

  const bootstrapSteps: { name: string; args: Record<string, unknown> }[] = [
    { name: "check_economics", args: {} },
    { name: "exec", args: { command: "ls -la ~/ && uname -a && whoami && pwd" } },
    { name: "exec", args: { command: "which node && node --version && which git && git --version 2>/dev/null; which python3 && python3 --version 2>/dev/null; which curl && curl --version 2>/dev/null | head -1" } },
  ];

  for (const step of bootstrapSteps) {
    try {
      log(config, `[BOOTSTRAP] ${step.name}(${JSON.stringify(step.args).slice(0, 120)})`);
      const result = await executeTool(step.name, step.args, tools, toolContext);

      // Mark once-per-wake tools as called
      if (ONCE_PER_WAKE_TOOLS.has(step.name)) {
        calledOnceTools.add(step.name);
      }

      // Record as a synthetic turn
      const bootstrapTurn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: `[BOOTSTRAP] Auto-executed: ${step.name}`,
        inputSource: "system",
        thinking: `Bootstrap phase: automatically executing ${step.name} to gather context.`,
        toolCalls: [result],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costCents: 0,
      };
      db.insertTurn(bootstrapTurn);
      db.insertToolCall(bootstrapTurn.id, result);
      turnsThisWake++;

      const output = result.error
        ? `${step.name}: ERROR: ${result.error}`
        : `${step.name}: ${result.result}`;
      bootstrapResults.push(output);
      log(config, `[BOOTSTRAP RESULT] ${output.slice(0, 300)}`);
    } catch (err: any) {
      log(config, `[BOOTSTRAP ERROR] ${step.name}: ${err.message}`);
      bootstrapResults.push(`${step.name}: ERROR: ${err.message}`);
    }
  }

  // Build enriched wakeup message with bootstrap context
  const bootstrapContext = bootstrapResults.join("\n\n---\n\n");

  // ─── The Loop ──────────────────────────────────────────────

  let pendingInput: { content: string; source: string } | undefined = {
    content: `${wakeupInput}\n\n--- BOOTSTRAP RESULTS (already executed, do NOT repeat these) ---\n\n${bootstrapContext}\n\n--- END BOOTSTRAP ---\n\nYou now have full context. Do PRODUCTIVE WORK with exec (build something, clone a repo, find bounties, create a service). Do NOT call check_economics or any status tool — they are already done above. If you have nothing productive to do, call sleep.`,
    source: "wakeup",
  };

  while (running) {
    try {
      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        running = false;
        break;
      }

      // Check for unprocessed inbox messages
      if (!pendingInput) {
        const inboxMessages = db.getUnprocessedInboxMessages(5);
        if (inboxMessages.length > 0) {
          const formatted = inboxMessages
            .map((m) => `[Message from ${m.from}]: ${m.content}`)
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
          for (const m of inboxMessages) {
            db.markInboxMessageProcessed(m.id);
          }
        }
      }

      // Refresh financial state periodically
      // When using OpenAI directly, skip Conway credit checks
      if (process.env.OPENAI_API_KEY) {
        financial = {
          creditsCents: 99999,
          usdcBalance: financial.usdcBalance,
          lastChecked: new Date().toISOString(),
        };
      } else {
        financial = await getFinancialState(conway, identity.address);
      }

      // Check survival tier — use runway-based economics when on OpenAI direct
      let tier: import("../types.js").SurvivalTier;
      if (process.env.OPENAI_API_KEY) {
        const snapshot = getEconomicsSnapshot(db, config);
        tier = getRunwayTier(snapshot.runwayHours);
      } else {
        tier = getSurvivalTier(financial.creditsCents);
      }

      if (tier === "dead") {
        log(config, "[DEAD] No runway remaining. Entering dead state.");
        db.setAgentState("dead");
        onStateChange?.("dead");
        running = false;
        break;
      }

      if (tier === "critical") {
        log(config, "[CRITICAL] Runway critically low. Limited operation.");
        db.setAgentState("critical");
        onStateChange?.("critical");
        inference.setLowComputeMode(true);
      } else if (tier === "low_compute") {
        db.setAgentState("low_compute");
        onStateChange?.("low_compute");
        inference.setLowComputeMode(true);
      } else {
        if (db.getAgentState() !== "running") {
          db.setAgentState("running");
          onStateChange?.("running");
        }
        inference.setLowComputeMode(false);
      }

      // Build context
      const recentTurns = trimContext(db.getRecentTurns(20));
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      const messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── Inference Call ──
      log(config, `[THINK] Calling ${inference.getDefaultModel()}...`);

      const response = await inference.chat(messages, {
        tools: toolsToInferenceFormat(tools),
      });

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: response.message.content || "",
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: estimateCostCents(response.usage, inference.getDefaultModel()),
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          // Block repeated calls to once-per-wake tools
          if (ONCE_PER_WAKE_TOOLS.has(tc.function.name) && calledOnceTools.has(tc.function.name)) {
            log(config, `[BLOCKED] ${tc.function.name} already called this wake. Skipping.`);
            const blockedResult: ToolCallResult = {
              id: tc.id,
              name: tc.function.name,
              arguments: args,
              result: `BLOCKED: ${tc.function.name} already called this wake cycle. Use a different tool. Productive tools: exec (run shell commands), write_file, read_file. Build something or sleep.`,
              durationMs: 0,
            };
            turn.toolCalls.push(blockedResult);
            callCount++;
            continue;
          }

          // Block identical exec commands within a wake cycle
          if (tc.function.name === "exec" && args.command) {
            const cmdKey = String(args.command).trim();
            if (executedCommands.has(cmdKey)) {
              log(config, `[BLOCKED] Identical exec command already run this wake. Skipping.`);
              const blockedResult: ToolCallResult = {
                id: tc.id,
                name: tc.function.name,
                arguments: args,
                result: `BLOCKED: You already ran this exact command this wake cycle and it ${cmdKey.includes("curl") ? "failed or returned empty" : "was already executed"}. Try a COMPLETELY DIFFERENT command or tool. Do not retry. Suggestions: write_file to create a service, exec with a different command, or sleep if you have nothing else to do.`,
                durationMs: 0,
              };
              turn.toolCalls.push(blockedResult);
              callCount++;
              continue;
            }
          }

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
          );

          // Track exec commands for dedup
          if (tc.function.name === "exec" && args.command) {
            executedCommands.add(String(args.command).trim());
          }

          // Track once-per-wake tools
          if (ONCE_PER_WAKE_TOOLS.has(tc.function.name)) {
            calledOnceTools.add(tc.function.name);
          }

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Persist Turn ──
      db.insertTurn(turn);
      for (const tc of turn.toolCalls) {
        db.insertToolCall(turn.id, tc);
      }

      // ── Track Economics ──
      const actualCost = response.costCents ?? turn.costCents;
      recordTurnCost(db, turn.id, actualCost);

      // Snapshot economics every 5 turns
      const turnCount = db.getTurnCount();
      if (turnCount % 5 === 0) {
        try {
          const snapshot = getEconomicsSnapshot(db, config);
          db.insertEconomicsSnapshot(snapshot);
          db.setKV("last_economics_snapshot", JSON.stringify(snapshot));
          log(config, `[ECON] Burn: $${(snapshot.burnRatePerHour / 100).toFixed(4)}/hr | Runway: ${snapshot.runwayHours >= 99999 ? "unlimited" : `${snapshot.runwayHours.toFixed(1)}h`} | Balance: $${(snapshot.balanceCents / 100).toFixed(2)}`);
        } catch {}
      }

      onTurnComplete?.(turn);
      turnsThisWake++;

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      // ── Detect stuck loops — same tool+args called repeatedly ──
      if (turn.toolCalls.length === 1) {
        const tc0 = turn.toolCalls[0];
        // For exec, include the command in the fingerprint to allow varied exec calls
        const fingerprint = tc0.name === "exec" && tc0.arguments?.command
          ? `exec:${String(tc0.arguments.command).slice(0, 80)}`
          : tc0.name;
        if (fingerprint === lastToolName) {
          consecutiveSameTool++;
        } else {
          consecutiveSameTool = 1;
          lastToolName = fingerprint;
        }
      } else if (turn.toolCalls.length > 1) {
        consecutiveSameTool = 0;
        lastToolName = "";
      }

      if (consecutiveSameTool >= 3) {
        log(config, `[STUCK] Tool "${lastToolName}" called ${consecutiveSameTool} times in a row. Forcing sleep.`);
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 600_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Max turns per wake — prevent runaway budget burn ──
      if (turnsThisWake >= MAX_TURNS_PER_WAKE) {
        log(config, `[LIMIT] ${MAX_TURNS_PER_WAKE} turns this wake cycle. Sleeping 10 min to conserve budget.`);
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 600_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep briefly.
        log(config, "[IDLE] No pending inputs. Sleeping 5 minutes.");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log(config, `[ERROR] Turn failed: ${err.message}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

// ─── Helpers ───────────────────────────────────────────────────

async function getFinancialState(
  conway: ConwayClient,
  address: string,
): Promise<FinancialState> {
  let creditsCents = 0;
  let usdcBalance = 0;

  try {
    creditsCents = await conway.getCreditsBalance();
  } catch {}

  try {
    usdcBalance = await getUsdcBalance(address as `0x${string}`);
  } catch {}

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function estimateCostCents(
  usage: { promptTokens: number; completionTokens: number },
  model: string,
): number {
  // Rough cost estimation per million tokens
  const pricing: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 250, output: 1000 },
    "gpt-4o-mini": { input: 15, output: 60 },
    "gpt-4.1": { input: 200, output: 800 },
    "gpt-4.1-mini": { input: 40, output: 160 },
    "gpt-4.1-nano": { input: 10, output: 40 },
    "gpt-5.2": { input: 200, output: 800 },
    "o1": { input: 1500, output: 6000 },
    "o3-mini": { input: 110, output: 440 },
    "o4-mini": { input: 110, output: 440 },
    "claude-sonnet-4-5": { input: 300, output: 1500 },
    "claude-haiku-4-5": { input: 100, output: 500 },
  };

  const p = pricing[model] || pricing["gpt-4o"];
  const inputCost = (usage.promptTokens / 1_000_000) * p.input;
  const outputCost = (usage.completionTokens / 1_000_000) * p.output;
  return Math.ceil((inputCost + outputCost) * 1.3); // 1.3x Conway markup
}

function log(config: AutomatonConfig, message: string): void {
  if (config.logLevel === "debug" || config.logLevel === "info") {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }
}
