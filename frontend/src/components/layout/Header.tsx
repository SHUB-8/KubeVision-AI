import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import {
  RefreshCw,
  Layers,
  Clock,
  ChevronDown,
  CheckCircle2,
} from 'lucide-react';

const COMMON_NAMESPACES = ['boutique', 'monitoring', 'kube-system', 'default'];
const TIME_WINDOWS = ['1m', '5m', '15m', '30m', '1h', '6h', '24h'];
const REFRESH_INTERVALS = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
];

/**
 * Slim status bar: telemetry store health on the left, global query
 * controls on the right. Brand and navigation live in the sidebar.
 */
export const Header: React.FC = () => {
  const {
    activeNamespace,
    setActiveNamespace,
    timeWindow,
    setTimeWindow,
    refreshInterval,
    setRefreshInterval,
    triggerRefresh,
    lastRefreshed,
    health,
  } = useApp();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [customNsInput, setCustomNsInput] = useState('');
  const [showNsDropdown, setShowNsDropdown] = useState(false);

  const handleManualRefresh = () => {
    setIsRefreshing(true);
    triggerRefresh();
    setTimeout(() => setIsRefreshing(false), 600);
  };

  // Health as a plain status dot + label — color carries the only meaning.
  const storeStatus = (name: string, status?: string) => {
    const isOk = status === 'ok' || (status ? !status.startsWith('error') : false);
    return (
      <span
        key={name}
        title={`${name}: ${status || 'unknown'}`}
        className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${isOk ? 'bg-emerald-500' : 'bg-rose-500'}`} />
        {name}
      </span>
    );
  };

  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-950 px-4">
      {/* Telemetry store health */}
      <div className="hidden lg:flex items-center gap-4">
        {storeStatus('Prometheus', health?.prometheus)}
        {storeStatus('Loki', health?.loki)}
        {storeStatus('Tempo', health?.tempo)}
        {storeStatus('K8s', health?.k8s ? health.k8s.split(' ')[0] : 'connected')}
      </div>
      <div className="lg:hidden font-semibold text-[13px] text-slate-100">KubeVision</div>

      {/* Global query controls */}
      <div className="flex items-center gap-2">
        {/* Namespace picker */}
        <div className="relative">
          <button
            onClick={() => setShowNsDropdown(!showNsDropdown)}
            aria-expanded={showNsDropdown}
            aria-haspopup="menu"
            className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-slate-800 bg-slate-900 text-xs text-slate-300 hover:border-slate-600 transition-colors"
          >
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            <span className="font-mono text-slate-100">{activeNamespace}</span>
            <ChevronDown className="w-3 h-3 text-slate-500" />
          </button>

          {showNsDropdown && (
            <div
              role="menu"
              className="absolute right-0 mt-1.5 w-52 rounded-md border border-slate-800 bg-slate-900 py-1 shadow-xl z-50"
            >
              <div className="px-3 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Namespace
              </div>
              {COMMON_NAMESPACES.map((ns) => (
                <button
                  key={ns}
                  role="menuitem"
                  onClick={() => {
                    setActiveNamespace(ns);
                    setShowNsDropdown(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-1 text-xs font-mono transition-colors ${
                    activeNamespace === ns
                      ? 'text-cyan-300 bg-slate-850'
                      : 'text-slate-300 hover:bg-slate-850'
                  }`}
                >
                  {ns}
                  {activeNamespace === ns && <CheckCircle2 className="w-3.5 h-3.5" />}
                </button>
              ))}
              <div className="border-t border-slate-800 p-2">
                <input
                  type="text"
                  placeholder="Custom namespace…"
                  value={customNsInput}
                  onChange={(e) => setCustomNsInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customNsInput.trim()) {
                      setActiveNamespace(customNsInput.trim());
                      setCustomNsInput('');
                      setShowNsDropdown(false);
                    }
                  }}
                  aria-label="Custom namespace"
                  className="w-full rounded-sm border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 font-mono placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
          )}
        </div>

        {/* Time window */}
        <div
          role="group"
          aria-label="Time window"
          className="hidden sm:flex items-center h-7 rounded-md border border-slate-800 bg-slate-900 p-0.5"
        >
          <Clock className="w-3 h-3 text-slate-500 mx-1.5" />
          {TIME_WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setTimeWindow(w)}
              aria-pressed={timeWindow === w}
              className={`px-1.5 py-0.5 rounded-sm font-mono text-[11px] transition-colors ${
                timeWindow === w
                  ? 'bg-slate-800 text-slate-100 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Refresh */}
        <div className="flex items-center gap-1 h-7 rounded-md border border-slate-800 bg-slate-900 px-1">
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            aria-label="Auto-refresh interval"
            className="bg-transparent text-slate-300 text-[11px] font-mono px-1 cursor-pointer focus:outline-none"
          >
            {REFRESH_INTERVALS.map((int) => (
              <option key={int.value} value={int.value} className="bg-slate-900">
                {int.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleManualRefresh}
            className="p-1 text-slate-400 hover:text-cyan-300 rounded-sm transition-colors"
            title="Refresh now"
            aria-label="Refresh now"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <span className="hidden lg:inline text-[11px] font-mono text-slate-500 tabular-nums">
          {lastRefreshed.toLocaleTimeString()}
        </span>
      </div>
    </header>
  );
};

export default Header;
