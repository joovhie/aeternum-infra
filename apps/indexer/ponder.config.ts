/**
 * ponder.config.ts
 *
 * Network and indexing configuration for the Aeternum protocol.
 * Defines RPC endpoints, sync throttling limits, and contract event
 * tracking targets.
 *
 * MULTI-CHAIN UPDATE: mainnet indexing is added alongside Sepolia only
 * once MAINNET_RPC_URL, MAINNET_CONTRACT_ADDRESS, and
 * MAINNET_CONTRACT_DEPLOY_BLOCK are all set. Left unset (the default,
 * pre-mainnet-deployment state), this behaves exactly as before —
 * Sepolia only, falling back to the original generic env var names
 * (RPC_URL, CONTRACT_ADDRESS, CONTRACT_DEPLOY_BLOCK, CHAIN_ID) so an
 * existing deployment's env doesn't need to change to keep working.
 *
 * The per-network contract override syntax below (`chain: { sepolia: {...},
 * mainnet: {...} }` replacing the single `chain: "sepolia"` string) and the
 * `ChainConfig` type import are both confirmed against the actual pinned
 * ponder@0.16.6 package's type declarations — not guessed.
 */

import { createConfig, type ContractConfig, type ChainConfig } from "ponder";
import { AETERNUM_VAULT_ABI } from "@aeternum/blockchain";

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? process.env.RPC_URL;
const SEPOLIA_CHAIN_ID = parseInt(process.env.SEPOLIA_CHAIN_ID ?? process.env.CHAIN_ID ?? "11155111");
const SEPOLIA_CONTRACT_ADDRESS = (process.env.SEPOLIA_CONTRACT_ADDRESS ??
  process.env.CONTRACT_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
const SEPOLIA_DEPLOY_BLOCK = parseInt(
  process.env.SEPOLIA_CONTRACT_DEPLOY_BLOCK ?? process.env.CONTRACT_DEPLOY_BLOCK ?? "11140604",
);

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const MAINNET_CHAIN_ID = parseInt(process.env.MAINNET_CHAIN_ID ?? "1");
const MAINNET_CONTRACT_ADDRESS = process.env.MAINNET_CONTRACT_ADDRESS as `0x${string}` | undefined;
const MAINNET_DEPLOY_BLOCK = process.env.MAINNET_CONTRACT_DEPLOY_BLOCK
  ? parseInt(process.env.MAINNET_CONTRACT_DEPLOY_BLOCK)
  : undefined;

const mainnetConfigured = Boolean(MAINNET_RPC_URL && MAINNET_CONTRACT_ADDRESS && MAINNET_DEPLOY_BLOCK !== undefined);

const chains: Record<string, ChainConfig> = {
  sepolia: {
    id: SEPOLIA_CHAIN_ID,
    rpc: SEPOLIA_RPC_URL,
    maxRequestsPerSecond: 10,
    // Force Ponder to fetch logs in smaller chunks to avoid payload timeouts
    ethGetLogsBlockRange: 1000,
  },
};

let vaultContract: ContractConfig = {
  abi: AETERNUM_VAULT_ABI,
  chain: "sepolia",
  address: SEPOLIA_CONTRACT_ADDRESS,
  startBlock: SEPOLIA_DEPLOY_BLOCK,
};

// Mainnet is only added once fully configured — a half-set env (e.g. RPC
// URL but no address yet) should not silently start syncing against the
// zero address the way the old single-chain fallback did.
if (mainnetConfigured) {
  chains.mainnet = {
    id: MAINNET_CHAIN_ID,
    rpc: MAINNET_RPC_URL,
    maxRequestsPerSecond: 10,
    ethGetLogsBlockRange: 1000,
  };

  vaultContract = {
    abi: AETERNUM_VAULT_ABI,
    chain: {
      sepolia: { address: SEPOLIA_CONTRACT_ADDRESS, startBlock: SEPOLIA_DEPLOY_BLOCK },
      mainnet: { address: MAINNET_CONTRACT_ADDRESS as `0x${string}`, startBlock: MAINNET_DEPLOY_BLOCK as number },
    },
  } as ContractConfig;
}

export default createConfig({
  chains,
  contracts: {
    AeternumVault: vaultContract,
  },
});
