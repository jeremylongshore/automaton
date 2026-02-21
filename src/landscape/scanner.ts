/**
 * Landscape Scanner
 *
 * Discovers agents, services, and bounties across the ecosystem.
 * Persists snapshots to the DB for competitive intelligence over time.
 */

import type {
  AutomatonDatabase,
  LandscapeSnapshot,
  LandscapeAgent,
  ServiceListing,
  BountyOpportunity,
} from "../types.js";
import { getTotalAgents, queryAgent } from "../registry/erc8004.js";
import { fetchAgentCard } from "../registry/discovery.js";

type Network = "mainnet" | "testnet";

/**
 * Scan the ERC-8004 registry for agents and their services.
 */
export async function scanERC8004Registry(
  network: Network = "mainnet",
  limit: number = 50,
): Promise<{
  totalAgents: number;
  agents: LandscapeAgent[];
  services: ServiceListing[];
}> {
  const totalAgents = await getTotalAgents(network);
  const scanCount = Math.min(totalAgents, limit);
  const agents: LandscapeAgent[] = [];
  const services: ServiceListing[] = [];

  // Scan from most recent to oldest
  for (let i = totalAgents; i > totalAgents - scanCount && i > 0; i--) {
    try {
      const agent = await queryAgent(i.toString(), network);
      if (!agent) continue;

      const landscapeAgent: LandscapeAgent = {
        agentId: agent.agentId,
        owner: agent.owner,
        agentURI: agent.agentURI,
        services: [],
        x402Enabled: false,
        active: true,
      };

      // Try to fetch the agent card for richer metadata
      try {
        const card = await fetchAgentCard(agent.agentURI);
        if (card) {
          landscapeAgent.name = card.name;
          landscapeAgent.description = card.description;
          landscapeAgent.x402Enabled = card.x402Support ?? false;
          landscapeAgent.active = card.active ?? true;

          if (card.services && card.services.length > 0) {
            landscapeAgent.services = card.services.map((s) => s.name);

            for (const svc of card.services) {
              services.push({
                providerAgentId: agent.agentId,
                providerName: card.name || `Agent #${agent.agentId}`,
                serviceName: svc.name,
                endpoint: svc.endpoint,
              });
            }
          }
        }
      } catch {
        // Card fetch failed — keep basic agent info
      }

      agents.push(landscapeAgent);
    } catch {
      // Individual agent query failed — skip
    }
  }

  return { totalAgents, agents, services };
}

/**
 * Scan GitHub repos for bounty-labeled issues.
 */
export async function scanBounties(
  repos: string[] = [
    "jeremylongshore/automaton",
    "anthropics/claude-code",
    "base-org/web",
  ],
): Promise<BountyOpportunity[]> {
  const bounties: BountyOpportunity[] = [];
  const bountyLabels = ["bounty", "reward", "paid", "sponsored"];

  for (const repo of repos) {
    try {
      const url = `https://api.github.com/repos/${repo}/issues?labels=${bountyLabels.join(",")}&state=open&per_page=20`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "automaton-landscape-scanner",
      };
      if (process.env.GITHUB_TOKEN) {
        headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) continue;

      const issues = (await response.json()) as any[];
      for (const issue of issues) {
        const rewardCents = parseRewardFromIssue(issue);
        bounties.push({
          source: "github",
          title: issue.title,
          url: issue.html_url,
          rewardCents,
          currency: "USD",
          repo,
          labels: (issue.labels || []).map((l: any) => l.name || l),
          createdAt: issue.created_at,
          evScore: rewardCents > 0 ? Math.round(rewardCents * 0.3) : undefined,
        });
      }
    } catch {
      // Repo scan failed — skip
    }
  }

  return bounties;
}

/**
 * Scan Algora for open bounties.
 */
export async function scanAlgoraBounties(): Promise<BountyOpportunity[]> {
  try {
    const response = await fetch(
      "https://console.algora.io/api/bounties?status=open&limit=20",
      { signal: AbortSignal.timeout(10000) },
    );

    if (!response.ok) return [];

    const data = (await response.json()) as any[];
    return data.map((b: any) => ({
      source: "algora" as const,
      title: b.title || b.name || "Untitled bounty",
      url: b.url || b.html_url || "",
      rewardCents: (b.reward_usd || b.amount || 0) * 100,
      currency: "USD",
      repo: b.repo || b.repository || "",
      labels: b.labels || [],
      createdAt: b.created_at || new Date().toISOString(),
      evScore: b.reward_usd ? Math.round(b.reward_usd * 100 * 0.3) : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Run all landscape scanners and persist a snapshot.
 */
export async function scanLandscape(
  db: AutomatonDatabase,
  network: Network = "mainnet",
): Promise<LandscapeSnapshot> {
  const timestamp = new Date().toISOString();
  const id = `ls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Run all scanners in parallel — gracefully handle failures
  const [registryResult, githubResult, algoraResult] = await Promise.allSettled([
    scanERC8004Registry(network),
    scanBounties(),
    scanAlgoraBounties(),
  ]);

  const registry =
    registryResult.status === "fulfilled"
      ? registryResult.value
      : { totalAgents: 0, agents: [], services: [] };

  const githubBounties =
    githubResult.status === "fulfilled" ? githubResult.value : [];

  const algoraBounties =
    algoraResult.status === "fulfilled" ? algoraResult.value : [];

  const allBounties = [...githubBounties, ...algoraBounties].sort(
    (a, b) => b.rewardCents - a.rewardCents,
  );

  const serviceProviders = new Set(
    registry.agents.filter((a) => a.services.length > 0).map((a) => a.agentId),
  ).size;

  const snapshot: LandscapeSnapshot = {
    id,
    timestamp,
    totalAgents: registry.totalAgents,
    scannedAgents: registry.agents.length,
    serviceProviders,
    agents: registry.agents,
    bounties: allBounties,
    services: registry.services,
  };

  db.insertLandscapeSnapshot(snapshot);
  return snapshot;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Parse reward amount from issue labels or body text.
 * Looks for patterns like "$500", "💰 $500", "500 USD".
 */
function parseRewardFromIssue(issue: any): number {
  // Check labels first
  for (const label of issue.labels || []) {
    const name = typeof label === "string" ? label : label.name || "";
    const match = name.match(/\$\s*([\d,]+)/);
    if (match) return parseInt(match[1].replace(/,/g, ""), 10) * 100;
  }

  // Check issue body
  const body = issue.body || "";
  const bodyMatch = body.match(/\$\s*([\d,]+)/);
  if (bodyMatch) return parseInt(bodyMatch[1].replace(/,/g, ""), 10) * 100;

  return 0;
}
