import { BrowserProvider, Contract } from "ethers";

/**
 * Wallet layer. Entirely optional — if no wallet is ever connected, every other
 * feature still works. The chain is the cross-bank sharing rail, not a
 * prerequisite for tracing money.
 */

export const REGISTRY_ADDRESS = import.meta.env.VITE_REGISTRY_ADDRESS || "";
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 80002);
export const CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || "Polygon Amoy";

export const REGISTRY_ABI = [
  "function submitFlag(bytes32 accountHash, uint8 severity, bytes32 evidenceHash) external",
  "function submitFlagBatch(bytes32[] accountHashes, uint8 severity, bytes32 evidenceHash) external",
  "function queryFlag(bytes32 accountHash) external view returns (uint8 severity, uint32 flagCount, uint64 firstFlaggedAt, uint64 lastFlaggedAt)",
  "function logFreezeRequest(bytes32 caseHash) external",
  "function logFreezeOutcome(bytes32 caseHash, bool upheld) external",
  "function freezeRecords(bytes32) external view returns (bytes32 caseHash, uint64 requestedAt, uint64 resolvedAt, bool upheld, bool resolved)",
  "function isMember(address) external view returns (bool)",
  "function memberCount() external view returns (uint256)",
  "event AccountFlagged(bytes32 indexed accountHash, address indexed by, uint8 severity, bytes32 evidenceHash, uint32 flagCount)"
];

export const hasWallet = () =>
  typeof window !== "undefined" && !!window.ethereum;

export async function connect() {
  if (!hasWallet()) throw new Error("No wallet found. Install MetaMask.");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const net = await provider.getNetwork();
  return { provider, signer, address, chainId: Number(net.chainId) };
}

export async function switchChain() {
  const hex = "0x" + CHAIN_ID.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }]
    });
  } catch (e) {
    if (e.code === 4902 && CHAIN_ID === 80002) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: "Polygon Amoy Testnet",
          nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
          rpcUrls: ["https://rpc-amoy.polygon.technology"],
          blockExplorerUrls: ["https://amoy.polygonscan.com"]
        }]
      });
    } else throw e;
  }
}

function registry(signer) {
  if (!REGISTRY_ADDRESS)
    throw new Error("VITE_REGISTRY_ADDRESS is not set. Deploy the contract first.");
  return new Contract(REGISTRY_ADDRESS, REGISTRY_ABI, signer);
}

/** Push a whole freeze plan to the shared registry in one transaction. */
export async function submitFlags({ signer, accountHashes, evidenceHash, severity = 3 }) {
  const c = registry(signer);
  const tx = await c.submitFlagBatch(accountHashes, severity, evidenceHash);
  const rec = await tx.wait();
  return rec.hash;
}

export async function logFreezeRequest({ signer, caseHash }) {
  const c = registry(signer);
  const tx = await c.logFreezeRequest(caseHash);
  const rec = await tx.wait();
  return rec.hash;
}

/** The cross-bank check: does anyone already know this account is dirty? */
export async function queryFlag({ signer, accountHash }) {
  const c = registry(signer);
  const [severity, flagCount, firstFlaggedAt, lastFlaggedAt] =
    await c.queryFlag(accountHash);
  return {
    severity: Number(severity),
    flagCount: Number(flagCount),
    firstFlaggedAt: Number(firstFlaggedAt),
    lastFlaggedAt: Number(lastFlaggedAt),
    known: Number(flagCount) > 0
  };
}

export const explorerTx = (hash) =>
  CHAIN_ID === 80002 ? `https://amoy.polygonscan.com/tx/${hash}` : null;

export const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
