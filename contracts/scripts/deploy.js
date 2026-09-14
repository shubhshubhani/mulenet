const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(bal));

  const F = await hre.ethers.getContractFactory("MuleFlagRegistry");
  const c = await F.deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();

  // Add a couple of demo member banks so the cross-bank query has participants.
  const signers = await hre.ethers.getSigners();
  if (signers.length > 2) {
    await (await c.addMember(signers[1].address, "HDFC Bank")).wait();
    await (await c.addMember(signers[2].address, "State Bank of India")).wait();
    console.log("Added 2 demo member banks");
  }

  console.log("\n  MuleFlagRegistry deployed to:", addr);
  console.log("  Network:", hre.network.name);
  console.log("\n  Put this in client/.env  ->  VITE_REGISTRY_ADDRESS=" + addr + "\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
