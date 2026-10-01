import React from 'react';
import { useApp, TabType } from '../../context/AppContext';
import {
  LifeBuoy,
  Waypoints,
  Server,
  GitBranch,
  Terminal,
  Boxes,
  Zap,
  SlidersHorizontal,
} from 'lucide-react';

export interface TabItem {
  id: TabType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const TABS: TabItem[] = [
  { id: 'topology', label: 'Topology', description: 'Live service dependency graph from eBPF peer flows', icon: Waypoints },
  { id: 'services', label: 'Services', description: 'RED metrics per service, with endpoint drill-down', icon: Server },
  { id: 'traces', label: 'Traces', description: 'Distributed trace search and span waterfall', icon: GitBranch },
  { id: 'logs', label: 'Logs', description: 'Pod log stream from Loki', icon: Terminal },
  { id: 'cluster', label: 'Cluster', description: 'Nodes, pods and cluster health', icon: Boxes },
  { id: 'incidents', label: 'Incidents', description: 'Anomaly pipeline and root-cause analysis', icon: Zap },
  { id: 'settings', label: 'Settings', description: 'Thresholds, ML parameters and display options', icon: SlidersHorizontal },
];

/**
 * Sidebar navigation (desktop). The mobile variant renders from the same
 * TABS list — see MobileNav in App.tsx.
 */
export const Navigation: React.FC = () => {
  const { activeTab, setActiveTab } = useApp();

  return (
    <nav
      aria-label="Primary"
      className="hidden md:flex w-52 shrink-0 flex-col border-r border-slate-800 bg-slate-950"
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-12">
        <LifeBuoy className="w-4 h-4 text-cyan-400" strokeWidth={2.2} />
        <span className="text-sm font-semibold tracking-tight text-slate-100">
          KubeVision AI
        </span>
      </div>

      <div className="flex-1 py-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative w-full flex items-center gap-2.5 pl-4 pr-3 py-1.5 text-[13px] transition-colors ${
                isActive
                  ? 'bg-slate-900 text-slate-100 font-medium'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-cyan-400" />
              )}
              <Icon
                className={`w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-slate-500'}`}
              />
              {tab.label}
            </button>
          );
        })}
      </div>

    </nav>
  );
};

/** Horizontal nav for <md screens, rendered under the status bar. */
export const MobileNav: React.FC = () => {
  const { activeTab, setActiveTab } = useApp();
  return (
    <nav
      aria-label="Primary"
      className="md:hidden flex items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-950 px-2 py-1.5"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs whitespace-nowrap ${
              isActive
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-cyan-400' : ''}`} />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
};

export default Navigation;
