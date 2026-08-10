/**
 * ponder.config.ts
 *
 * Network and indexing configuration for the Aeternum protocol.
 * Defines RPC endpoints, sync throttling limits, and contract event 
 * tracking targets for the Ethereum Sepolia testnet.
 */

import { createConfig } from "ponder";
import { AETERNUM_VAULT_ABI } from "@aeternum/blockchain";

export default createConfig({
  chains: {
    sepolia: {
      id: parseInt(process.env.CHAIN_ID || "11155111"),
      rpc: process.env.RPC_URL,
      maxRequestsPerSecond: 10,
      // Force Ponder to fetch logs in smaller chunks to avoid payload timeouts
      ethGetLogsBlockRange: 1000, 
    },
  },
  contracts: {
    AeternumVault: {
      abi: AETERNUM_VAULT_ABI,
      chain: "sepolia",
      // Set dynamically via env or fallback to your hardcoded testnet address
      address: (process.env.CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`,
      startBlock: parseInt(process.env.CONTRACT_DEPLOY_BLOCK ?? "11140604"),
    },
  },
});