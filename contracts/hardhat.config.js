require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    // Local chain for development. No faucet, no waiting.
    localhost: { url: "http://127.0.0.1:8545" },

    // Polygon Amoy is the CURRENT Polygon testnet.
    // Mumbai was shut down in April 2024 - do not use it.
    amoy: {
      url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: PK ? [PK] : []
    }
  }
};
