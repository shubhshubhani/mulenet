import React from "react";
import {
  hasWallet, connect, switchChain, CHAIN_ID, CHAIN_NAME,
  REGISTRY_ADDRESS, short
} from "../chain.js";

export default function WalletBar({ wallet, setWallet, notify }) {
  const [busy, setBusy] = React.useState(false);

  const doConnect = async () => {
    setBusy(true);
    try {
      let w = await connect();
      if (w.chainId !== CHAIN_ID) {
        await switchChain();
        w = await connect();
      }
      setWallet(w);
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!hasWallet())
    return (
      <span className="pill" title="Everything except the shared registry works without a wallet.">
        no wallet · registry off
      </span>
    );

  if (!wallet)
    return (
      <button className="ghost sm" onClick={doConnect} disabled={busy}>
        {busy ? "connecting…" : "Connect wallet"}
      </button>
    );

  const wrong = wallet.chainId !== CHAIN_ID;
  return (
    <div className="row">
      <span className={`pill ${wrong ? "warn" : "violet"}`}>
        {short(wallet.address)} · {wrong ? "wrong chain" : CHAIN_NAME}
      </span>
      {!REGISTRY_ADDRESS && (
        <span className="pill warn" title="Set VITE_REGISTRY_ADDRESS in client/.env">
          contract not deployed
        </span>
      )}
    </div>
  );
}
