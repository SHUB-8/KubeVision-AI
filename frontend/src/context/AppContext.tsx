import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { HealthResponse, UISettings } from '../types/api';
import { api } from '../services/api';

export type TabType = 'topology' | 'services' | 'traces' | 'logs' | 'events' | 'cluster' | 'incidents' | 'settings';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

interface AppContextType {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  activeNamespace: string;
  setActiveNamespace: (ns: string) => void;
  timeWindow: string;
  setTimeWindow: (w: string) => void;
  refreshInterval: number;
  setRefreshInterval: (sec: number) => void;
  refreshCount: number;
  triggerRefresh: () => void;
  lastRefreshed: Date;
  health: HealthResponse | null;
  config: UISettings | null;
  updateConfigState: (newConfig: UISettings) => void;
  toasts: ToastMessage[];
  addToast: (type: ToastMessage['type'], message: string) => void;
  removeToast: (id: string) => void;
  selectedService: string | null;
  setSelectedService: (svc: string | null) => void;
  selectedTraceId: string | null;
  setSelectedTraceId: (traceId: string | null) => void;
  // One-shot seeds for cross-view navigation with preset filters (e.g. the
  // topology panel's "error logs" / "slow traces" actions). Consumers apply
  // the seed once and clear it.
  logSeed: { keyword?: string } | null;
  setLogSeed: (seed: { keyword?: string } | null) => void;
  traceSeed: { minDurationMs?: number } | null;
  setTraceSeed: (seed: { minDurationMs?: number } | null) => void;
  /** True once the persisted config (namespace, window) has been applied.
   *  Views gate their first fetch on this: otherwise every view fires one
   *  request without the saved namespace and a second one right after. */
  configReady: boolean;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const TAB_IDS: TabType[] = [
  'topology', 'services', 'traces', 'logs', 'events', 'cluster', 'incidents', 'settings',
];

/** `#/logs`, `#/traces`, `#/trace/<id>` — shareable and refresh-safe. */
function parseHash(): { tab: TabType | null; traceId: string | null } {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h) return { tab: null, traceId: null };
  const parts = h.split('/');
  if (parts[0] === 'trace' && parts[1]) {
    return { tab: 'traces', traceId: decodeURIComponent(parts[1]) };
  }
  if ((TAB_IDS as string[]).includes(parts[0])) {
    return { tab: parts[0] as TabType, traceId: null };
  }
  return { tab: null, traceId: null };
}

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [activeTab, setActiveTab] = useState<TabType>(() => parseHash().tab ?? 'topology');
  // Empty until the saved config arrives; API calls with an empty namespace
  // fall back to the backend's OBSERVED_NAMESPACE default.
  const [activeNamespace, setActiveNamespace] = useState<string>('');
  const [timeWindow, setTimeWindow] = useState<string>('5m');
  const [refreshInterval, setRefreshInterval] = useState<number>(15);
  const [refreshCount, setRefreshCount] = useState<number>(0);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [config, setConfig] = useState<UISettings | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(() => parseHash().traceId);
  const [logSeed, setLogSeed] = useState<{ keyword?: string } | null>(null);
  const [traceSeed, setTraceSeed] = useState<{ minDurationMs?: number } | null>(null);
  const [configReady, setConfigReady] = useState(false);

  const addToast = useCallback((type: ToastMessage['type'], message: string) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const triggerRefresh = useCallback(() => {
    setRefreshCount((c) => c + 1);
    setLastRefreshed(new Date());
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const data = await api.getHealth();
      setHealth(data);
    } catch (err: any) {
      console.warn('Failed to fetch health status:', err.message);
    }
  }, []);

  // Runs once on mount. The saved namespace/timeWindow/refreshInterval are
  // applied here only - re-applying on later runs would snap the user's
  // in-session selections back to the stored config.
  const fetchConfig = useCallback(async () => {
    try {
      const cfg = await api.getConfig();
      setConfig(cfg);
      if (cfg.namespace) {
        setActiveNamespace(cfg.namespace);
      }
      if (cfg.timeWindow) {
        setTimeWindow(cfg.timeWindow);
      }
      if (cfg.refreshInterval) {
        setRefreshInterval(cfg.refreshInterval);
      }
    } catch (err: any) {
      console.warn('Failed to fetch config:', err.message);
    } finally {
      // Gate initial view fetches even when the config request fails: the
      // backend default namespace is used either way, so one fetch is enough.
      setConfigReady(true);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchHealth();
    fetchConfig();
  }, [fetchHealth, fetchConfig]);

  // Periodic health check & auto-refresh trigger
  useEffect(() => {
    if (refreshInterval <= 0) return;
    const interval = setInterval(() => {
      triggerRefresh();
      fetchHealth();
    }, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshInterval, triggerRefresh, fetchHealth]);

  // Deep links: keep the URL in step with the visible view (and the open
  // trace), so any screen can be shared or refreshed in place.
  useEffect(() => {
    const hash =
      selectedTraceId && activeTab === 'traces'
        ? `#/trace/${selectedTraceId}`
        : `#/${activeTab}`;
    if (window.location.hash !== hash) {
      window.history.pushState(null, '', hash);
    }
  }, [activeTab, selectedTraceId]);

  useEffect(() => {
    const onPop = () => {
      const { tab, traceId } = parseHash();
      if (tab) setActiveTab(tab);
      setSelectedTraceId(traceId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const updateConfigState = useCallback((newConfig: UISettings) => {
    setConfig(newConfig);
    if (newConfig.namespace) setActiveNamespace(newConfig.namespace);
    if (newConfig.timeWindow) setTimeWindow(newConfig.timeWindow);
    if (newConfig.refreshInterval) setRefreshInterval(newConfig.refreshInterval);
  }, []);

  return (
    <AppContext.Provider
      value={{
        activeTab,
        setActiveTab,
        activeNamespace,
        setActiveNamespace,
        timeWindow,
        setTimeWindow,
        refreshInterval,
        setRefreshInterval,
        refreshCount,
        triggerRefresh,
        lastRefreshed,
        health,
        config,
        updateConfigState,
        toasts,
        addToast,
        removeToast,
        selectedService,
        setSelectedService,
        selectedTraceId,
        setSelectedTraceId,
        logSeed,
        setLogSeed,
        traceSeed,
        setTraceSeed,
        configReady,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
