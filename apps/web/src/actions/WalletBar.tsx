// The header's wallet control. With no wallet in the browser it shows nothing: every page reads
// without one.
import { Pill } from '../components.js';
import { chainName, isOurChain } from '../lib/chains.js';
import { short } from '../lib/format.js';
import { connectWallet, useWallet } from '../lib/wallet.js';
import '../styles/party.css';

export function WalletBar() {
  const w = useWallet();
  if (!w.available) return null;
  if (!w.account) {
    return (
      <div className="wallet wallet-off">
        <button type="button" className="secondary" disabled={w.connecting} onClick={() => void connectWallet()}>
          {w.connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
        {w.error && <span className="error small">{w.error}</span>}
      </div>
    );
  }
  return (
    <div className="wallet wallet-on">
      <a href={`#/party/${w.account}`} className="mono" title="Your claims and credit">
        {short(w.account, 4)}
      </a>
      <Pill tone={isOurChain(w.chainId) ? 'plain' : 'wait'}>{chainName(w.chainId)}</Pill>
    </div>
  );
}
