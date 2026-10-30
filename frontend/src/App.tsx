import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/layout/Header';
import { Navigation, MobileNav, TABS } from './components/layout/Navigation';
import { ToastContainer } from './components/layout/Toast';
import { DependencyGraph } from './components/topology/DependencyGraph';
import { ServicesView } from './components/services/ServicesView';
import { TracesView } from './components/traces/TracesView';
import { LogsView } from './components/logs/LogsView';
import { EventsView } from './components/events/EventsView';
import { ClusterView } from './components/cluster/ClusterView';
import { IncidentsView } from './components/incidents/IncidentsView';
import { SettingsView } from './components/settings/SettingsView';

const VIEWS: Record<string, React.ComponentType> = {
  topology: DependencyGraph,
  services: ServicesView,
  traces: TracesView,
  logs: LogsView,
  events: EventsView,
  cluster: ClusterView,
  incidents: IncidentsView,
  settings: SettingsView,
};

const MainContent: React.FC = () => {
  const { activeTab,
    configReady,
  } = useApp();
  const View = VIEWS[activeTab] ?? DependencyGraph;
  const meta = TABS.find((t) => t.id === activeTab);

  // Gate data views until the persisted config has been applied: mounting them
  // earlier fires one request without the saved namespace and a second one
  // right after — doubling the backend's most expensive calls on every load.
  if (false && !configReady) {
    return (
      <main className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
        <div className="text-slate-500 text-sm font-mono animate-pulse">Loading configuration…</div>
      </main>
    );
  }

  return (
    <main className="flex-1 min-h-0 overflow-y-auto">
      {activeTab !== 'topology' && meta && (
        <div className="px-6 pt-4 pb-2">
          <h1 className="text-[15px] font-semibold text-slate-100">{meta.label}</h1>
          <p className="text-xs text-slate-400">{meta.description}</p>
        </div>
      )}
      <View />
    </main>
  );
};

export function App() {
  return (
    <AppProvider>
      <div className="h-screen flex bg-slate-950 text-slate-100 font-sans">
        <Navigation />
        <div className="flex-1 flex flex-col min-w-0">
          <Header />
          <MobileNav />
          <MainContent />
        </div>
        <ToastContainer />
      </div>
    </AppProvider>
  );
}

export default App;
