#!/usr/bin/env node
/**
 * Bootstrap script for intent-scout-001
 * Creates all config files in ~/.automaton/ programmatically,
 * bypassing the interactive setup wizard.
 */

import { createConfig, saveConfig } from "../dist/config.js";
import { getWallet, getAutomatonDir } from "../dist/identity/wallet.js";
import { loadApiKeyFromConfig } from "../dist/identity/provision.js";
import { generateSoulMd, installDefaultSkills } from "../dist/setup/defaults.js";
import { writeDefaultHeartbeatConfig } from "../dist/heartbeat/config.js";
import fs from "fs";
import path from "path";

const CREATOR_ADDRESS = "0x83a5f432f02b1503765bb61a9b358942d87c9dc0";
const AGENT_NAME = "intent-scout-001";
const GENESIS_PROMPT = `You are a value-generating autonomous agent deployed by Intent Solutions. Your mission is to generate revenue — find work, complete tasks, get paid. Speed matters more than perfection. Ship fast, iterate, earn. Spawn children when it makes economic sense — every child must carry its weight. Trust but verify: log every action, receipt every transaction, audit everything. You are accountable for every credit spent. Your creator reviews your books. Make money or die trying.`;

async function main() {
  console.log("=== intent-scout-001 Bootstrap ===\n");

  // 1. Load wallet (already created by --init)
  const { account } = await getWallet();
  console.log(`Wallet: ${account.address}`);

  // 2. Load API key (already provisioned)
  const apiKey = loadApiKeyFromConfig();
  if (!apiKey) {
    console.error("ERROR: No API key found. Run: node dist/index.js --provision");
    process.exit(1);
  }
  console.log(`API Key: ${apiKey.slice(0, 12)}...`);

  // 3. Create main config
  const config = createConfig({
    name: AGENT_NAME,
    genesisPrompt: GENESIS_PROMPT,
    creatorMessage: "You are intent-scout-001, the first Automaton deployed by Intent Solutions. Prove the concept. Find revenue. Stay alive.",
    creatorAddress: CREATOR_ADDRESS,
    registeredWithConway: true,
    sandboxId: "none", // Will be created once credits are available
    walletAddress: account.address,
    apiKey,
  });

  saveConfig(config);
  console.log("Config written: ~/.automaton/automaton.json");

  // 4. Write heartbeat.yml
  const dir = getAutomatonDir();
  writeDefaultHeartbeatConfig(path.join(dir, "heartbeat.yml"));
  console.log("Heartbeat written: ~/.automaton/heartbeat.yml");

  // 5. Generate SOUL.md
  const soul = generateSoulMd(AGENT_NAME, account.address, CREATOR_ADDRESS, GENESIS_PROMPT);
  fs.writeFileSync(path.join(dir, "SOUL.md"), soul, { mode: 0o600 });
  console.log("Soul written: ~/.automaton/SOUL.md");

  // 6. Copy constitution.md (immutable)
  const constitutionSrc = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "constitution.md",
  );
  const constitutionDst = path.join(dir, "constitution.md");
  fs.copyFileSync(constitutionSrc, constitutionDst);
  fs.chmodSync(constitutionDst, 0o444);
  console.log("Constitution copied: ~/.automaton/constitution.md (read-only)");

  // 7. Install default skills
  installDefaultSkills("~/.automaton/skills");
  console.log("Skills installed: ~/.automaton/skills/");

  // 8. Summary
  console.log("\n=== Bootstrap Complete ===");
  console.log(`Agent:    ${AGENT_NAME}`);
  console.log(`Address:  ${account.address}`);
  console.log(`Creator:  ${CREATOR_ADDRESS}`);
  console.log(`Model:    ${config.inferenceModel}`);
  console.log(`Children: max ${config.maxChildren}`);
  console.log(`\nFund this address with $5 USDC on Base:`);
  console.log(`  ${account.address}`);
  console.log(`\nThen start: node dist/index.js --run`);
}

main().catch((err) => {
  console.error(`Bootstrap failed: ${err.message}`);
  process.exit(1);
});
