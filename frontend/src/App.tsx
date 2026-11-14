import React, { Suspense } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/layout/Header';
import { Navigation, MobileNav, TABS } from './components/layout/Navigation';
import { ToastContainer } from './components/layout/Toast';
import { LoadingSpinner } from './components/common/LoadingSpinner';

const DependencyGraph = React.lazy(() =>
  import('./components/topology/DependencyGraph').then((m) => ({ default: m.DependencyGraph }))
);
const ServicesView = React.lazy(() =>
  import('./components/services/ServicesView').then((m) => ({ default: m.ServicesView }))
);
const TracesView = React.lazy(() =>
  import('./components/traces/TracesView').then((m) => ({ default: m.TracesView }))
);
const LogsView = React.lazy(() =>
  import('./components/logs/LogsView').then((m) => ({ default: m.LogsView }))
);
const EventsView = React.lazy(() =>
  import('./components/events/EventsView').then((m) => ({ default: m.EventsView }))
);
const ClusterView = React.lazy(() =>
  import('./components/cluster/ClusterView').then((m) => ({ default: m.ClusterView }))
);
const IncidentsView = React.lazy(() =>
  import('./components/incidents/IncidentsView').then((m) => ({ default: m.IncidentsView }))
);
const SettingsView = React.lazy(() =>
  import('./components/settings/SettingsView').then((m) => ({ default: m.SettingsView }))
);

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
  if (!configReady) {
    return (
      <main className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
        <div className="text-slate-400 text-sm font-mono animate-pulse">Loading configuration…</div>
      </main>
    );
  }

  return (
    <main className="flex-1 min-h-0 overflow-y-auto">
      {/* Every view, topology included, opens on the same title block so the
          page chrome does not shift between tabs. */}
      {meta && (
        <div className="px-6 pt-4 pb-2">
          <h1 className="text-[15px] font-semibold text-slate-100">{meta.label}</h1>
          <p className="text-xs text-slate-400">{meta.description}</p>
        </div>
      )}
      <Suspense
        fallback={
          <div className="p-12 flex justify-center">
            <LoadingSpinner message="Loading view…" />
          </div>
        }
      >
        <View />
      </Suspense>
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
