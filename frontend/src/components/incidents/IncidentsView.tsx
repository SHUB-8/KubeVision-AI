import React from 'react';
import { BrainCircuit } from 'lucide-react';

/**
 * Placeholder — the ML anomaly pipeline (Isolation Forest screening → LSTM
 * verification) and the LangGraph RCA agents are not implemented yet, so
 * there is nothing real to render here. No sample data by design.
 */
export const IncidentsView: React.FC = () => {
  return (
    <div className="p-4 lg:p-8">
      <div className="p-12 rounded-md bg-slate-900/60 border border-slate-800 text-center max-w-2xl mx-auto mt-8">
        <BrainCircuit className="w-10 h-10 text-slate-600 mx-auto mb-4" />
        <p className="font-mono text-xs text-slate-500 uppercase tracking-[0.2em] mb-2">#todo</p>
        <h2 className="text-base font-semibold text-slate-100">Incidents &amp; RCA — not implemented yet</h2>
        <p className="text-xs text-slate-400 mt-2 leading-relaxed max-w-md mx-auto">
          This page will list anomalies from the ML pipeline (Isolation Forest screening →
          LSTM Autoencoder verification) with root-cause reports from the LangGraph agents.
          Neither is wired to live telemetry yet.
        </p>
      </div>
    </div>
  );
};

export default IncidentsView;
