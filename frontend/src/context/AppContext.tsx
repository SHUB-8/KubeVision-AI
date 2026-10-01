import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { HealthResponse, UISettings } from '../types/api';
import { api } from '../services/api';

export type TabType = 'topology' | 'services' | 'traces' | 'logs' | 'cluster' | 'incidents' | 'settings';

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
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [activeTab, setActiveTab] = useState<TabType>('topology');
  const [activeNamespace, setActiveNamespace] = useState<string>('boutique');
  const [timeWindow, setTimeWindow] = useState<string>('5m');
  const [refreshInterval, setRefreshInterval] = useState<number>(15);
  const [refreshCount, setRefreshCount] = useState<number>(0);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [config, setConfig] = useState<UISettings | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

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

  const fetchConfig = useCallback(async () => {
    try {
      const cfg = await api.getConfig();
      setConfig(cfg);
      if (cfg.namespace && !activeNamespace) {
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
    }
  }, [activeNamespace]);

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
