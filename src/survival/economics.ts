/**
 * Survival Economics Engine
 *
 * Core economics calculations: burn rate, earn rate, runway,
 * spawn gating, and sleep/wake decisions.
 *
 * All monetary values are in cents (integer).
 * All time values are in hours (float).
 */

import type {
  AutomatonDatabase,
  AutomatonConfig,
  EconomicsSnapshot,
  SpawnGate,
  SurvivalTier,
} from "../types.js";
import { RUNWAY_TIERS } from "../types.js";

const HOURS_PER_MONTH = 720; // 30 days * 24 hours

/**
 * Calculate burn rate in cents/hour from the turns table.
 * Uses total cost over total uptime.
 */
export function calculateBurnRate(db: AutomatonDatabase): number {
  const uptimeHours = getUptimeHours(db);
  if (uptimeHours <= 0) return 0;

  const totalSpent = getTotalSpent(db);
  return totalSpent / uptimeHours;
}

/**
 * Calculate earn rate in cents/hour from transfer_in transactions.
 */
export function calculateEarnRate(db: AutomatonDatabase): number {
  const uptimeHours = getUptimeHours(db);
  if (uptimeHours <= 0) return 0;

  const totalEarned = getTotalEarned(db);
  return totalEarned / uptimeHours;
}

/**
 * Calculate runway in hours: how long until balance hits 0.
 */
export function calculateRunway(balanceCents: number, burnRate: number): number {
  if (burnRate <= 0) return Infinity;
  return balanceCents / burnRate;
}

/**
 * Get the survival tier based on runway hours (not raw credits).
 */
export function getRunwayTier(runwayHours: number): SurvivalTier {
  if (runwayHours > RUNWAY_TIERS.normal) return "normal";
  if (runwayHours > RUNWAY_TIERS.low_compute) return "low_compute";
  if (runwayHours > RUNWAY_TIERS.critical) return "critical";
  return "dead";
}

/**
 * Build a full economics snapshot from current state.
 */
export function getEconomicsSnapshot(
  db: AutomatonDatabase,
  config: AutomatonConfig,
): EconomicsSnapshot {
  const burnRate = calculateBurnRate(db);
  const earnRate = calculateEarnRate(db);
  const totalSpent = getTotalSpent(db);
  const totalEarned = getTotalEarned(db);
  const balanceCents = config.budgetCents - totalSpent + totalEarned;
  const runwayHours = calculateRunway(Math.max(balanceCents, 0), burnRate);
  const turnCount = db.getTurnCount();
  const uptimeHours = getUptimeHours(db);
  const costPerTurn = turnCount > 0 ? totalSpent / turnCount : 0;
  const childTributeTotal = getChildTributeTotal(db);

  return {
    timestamp: new Date().toISOString(),
    budgetCents: config.budgetCents,
    totalSpentCents: totalSpent,
    totalEarnedCents: totalEarned,
    balanceCents: Math.max(balanceCents, 0),
    burnRatePerHour: burnRate,
    earnRatePerHour: earnRate,
    earnBurnRatio: burnRate > 0 ? earnRate / burnRate : 0,
    runwayHours: runwayHours === Infinity ? 99999 : runwayHours,
    costPerTurn,
    turnsTotal: turnCount,
    uptimeHours,
    childTributeTotal,
  };
}

/**
 * Check whether spawning is economically viable.
 *
 * SPAWN_THRESHOLD = own_monthly_cost + (num_children * child_monthly_cost)
 * CAN_SPAWN = balance >= SPAWN_THRESHOLD
 */
export function checkSpawnGate(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  numChildren: number = 1,
): SpawnGate {
  const burnRate = calculateBurnRate(db);
  const totalSpent = getTotalSpent(db);
  const totalEarned = getTotalEarned(db);
  const balanceCents = Math.max(config.budgetCents - totalSpent + totalEarned, 0);

  const ownMonthlyCost = burnRate * HOURS_PER_MONTH;
  // Estimate child burn rate at 80% of parent (smaller model, less activity)
  const childMonthlyCost = ownMonthlyCost * 0.8;
  const spawnThreshold = ownMonthlyCost + (numChildren * childMonthlyCost);
  const deficit = Math.max(spawnThreshold - balanceCents, 0);

  if (balanceCents < spawnThreshold) {
    return {
      canSpawn: false,
      reason: `Insufficient balance. Need $${(spawnThreshold / 100).toFixed(2)} (own: $${(ownMonthlyCost / 100).toFixed(2)}/mo + ${numChildren} child(ren): $${(childMonthlyCost / 100).toFixed(2)}/mo each), have $${(balanceCents / 100).toFixed(2)}`,
      balanceCents,
      ownMonthlyCost,
      childMonthlyCost,
      spawnThreshold,
      deficit,
    };
  }

  return {
    canSpawn: true,
    reason: "Spawn economics check passed",
    balanceCents,
    ownMonthlyCost,
    childMonthlyCost,
    spawnThreshold,
    deficit: 0,
  };
}

/**
 * Determine if the agent should sleep to conserve resources.
 *
 * SHOULD_SLEEP = (earn_burn_ratio < 0.5) AND (runway_hours < 24) AND (no_pending_tasks)
 */
export function shouldSleep(
  snapshot: EconomicsSnapshot,
  pendingTasks: number,
): boolean {
  if (pendingTasks > 0) return false;
  if (snapshot.earnBurnRatio >= 0.5) return false;
  if (snapshot.runwayHours >= 24) return false;
  return true;
}

/**
 * Record the cost of a single turn for economics tracking.
 */
export function recordTurnCost(
  db: AutomatonDatabase,
  turnId: string,
  costCents: number,
): void {
  db.setKV(`turn_cost_${turnId}`, String(costCents));

  // Update running total
  const currentTotal = Number(db.getKV("total_spent_cents") || "0");
  db.setKV("total_spent_cents", String(currentTotal + costCents));
}

/**
 * Format an economics snapshot as a human-readable report.
 */
export function formatEconomicsReport(snapshot: EconomicsSnapshot): string {
  const sustainLabel = snapshot.earnBurnRatio >= 1.0
    ? "SUSTAINABLE"
    : snapshot.earnBurnRatio >= 0.5
      ? "MARGINAL"
      : "UNSUSTAINABLE";

  const tier = getRunwayTier(snapshot.runwayHours);

  return `=== ECONOMICS REPORT ===
Budget:        $${(snapshot.budgetCents / 100).toFixed(2)}
Spent:         $${(snapshot.totalSpentCents / 100).toFixed(2)}
Earned:        $${(snapshot.totalEarnedCents / 100).toFixed(2)}
Balance:       $${(snapshot.balanceCents / 100).toFixed(2)}
Burn rate:     $${(snapshot.burnRatePerHour / 100).toFixed(4)}/hour
Earn rate:     $${(snapshot.earnRatePerHour / 100).toFixed(4)}/hour
Earn/Burn:     ${snapshot.earnBurnRatio.toFixed(2)} (${sustainLabel})
Runway:        ${snapshot.runwayHours >= 99999 ? "unlimited" : `${snapshot.runwayHours.toFixed(1)} hours`}
Tier:          ${tier}
Cost/turn:     $${(snapshot.costPerTurn / 100).toFixed(4)}
Total turns:   ${snapshot.turnsTotal}
Uptime:        ${snapshot.uptimeHours.toFixed(1)} hours
Child tribute: $${(snapshot.childTributeTotal / 100).toFixed(2)}
========================`;
}

// ─── Internal Helpers ─────────────────────────────────────────

function getUptimeHours(db: AutomatonDatabase): number {
  const startTime = db.getKV("start_time");
  if (!startTime) return 0;
  const ms = Date.now() - new Date(startTime).getTime();
  return Math.max(ms / (1000 * 60 * 60), 0.001); // min 0.001h to avoid div/0
}

function getTotalSpent(db: AutomatonDatabase): number {
  return Number(db.getKV("total_spent_cents") || "0");
}

function getTotalEarned(db: AutomatonDatabase): number {
  return Number(db.getKV("total_earned_cents") || "0");
}

function getChildTributeTotal(db: AutomatonDatabase): number {
  return Number(db.getKV("child_tribute_total_cents") || "0");
}
