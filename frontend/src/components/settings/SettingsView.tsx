import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { UISettings, LLMConfig } from '../../types/api';
import { LoadingSpinner } from '../common/LoadingSpinner';
import {
  Sliders,
  Save,
  RotateCcw,
  Bot,
  BrainCircuit,
  Activity,
  Layers,
  CheckCircle2,
  AlertCircle,
  Database,
} from 'lucide-react';

const DEFAULT_AGENT_CONFIGS: LLMConfig[] = [
  { role: 'Orchestrator', provider: 'gemini', model: 'gemini-1.5-pro', temperature: 0.2, maxTokens: 4096, fallbackProvider: 'openai' },
  { role: 'Metrics Agent', provider: 'groq', model: 'llama-3.3-70b-versatile', temperature: 0.1, maxTokens: 2048, fallbackProvider: 'ollama' },
  { role: 'Log Agent', provider: 'groq', model: 'llama-3.3-70b-versatile', temperature: 0.1, maxTokens: 2048, fallbackProvider: 'gemini' },
  { role: 'K8s Event Agent', provider: 'groq', model: 'llama-3.3-70b-versatile', temperature: 0.1, maxTokens: 2048, fallbackProvider: 'ollama' },
  { role: 'Network Agent', provider: 'groq', model: 'llama-3.3-70b-versatile', temperature: 0.1, maxTokens: 2048, fallbackProvider: 'gemini' },
  { role: 'RCA Generator', provider: 'openai', model: 'gpt-4o', temperature: 0.3, maxTokens: 8192, fallbackProvider: 'gemini' },
  { role: 'Self-Validator', provider: 'gemini', model: 'gemini-1.5-flash', temperature: 0.1, maxTokens: 2048, fallbackProvider: 'groq' },
];

export const SettingsView: React.FC = () => {
  const { config, updateConfigState, addToast } = useApp();
  const [formData, setFormData] = useState<UISettings | null>(config);
  const [agentConfigs, setAgentConfigs] = useState<LLMConfig[]>(DEFAULT_AGENT_CONFIGS);
  const [saving, setSaving] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'thresholds' | 'llm' | 'display'>('thresholds');

  useEffect(() => {
    if (config) {
      setFormData(config);
    }
  }, [config]);

  if (!formData) {
    return (
      <div className="p-12 flex justify-center">
        <LoadingSpinner message="Loading configuration from BadgerDB..." />
      </div>
    );
  }

  const handleThresholdChange = (key: keyof UISettings['thresholds'], val: number) => {
    setFormData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        thresholds: {
          ...prev.thresholds,
          [key]: val,
        },
      };
    });
  };

  const handleDisplayChange = (key: keyof UISettings['display'], val: boolean) => {
    setFormData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        display: {
          ...prev.display,
          [key]: val,
        },
      };
    });
  };

  const handleAgentConfigChange = (idx: number, field: keyof LLMConfig, val: any) => {
    setAgentConfigs((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: val };
      return updated;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.updateConfig(formData);
      updateConfigState(updated);
      addToast('success', 'System configuration updated & saved to BadgerDB');
    } catch (err: any) {
      addToast('error', `Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Settings Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-md bg-slate-900/80 border border-slate-800">
        <div className="flex items-center gap-3.5">
          <div className="p-2.5 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Sliders className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-100 tracking-tight">
              KubeVision AI Configuration
            </h2>
            <p className="text-xs text-slate-400 font-mono">
              Persisted in BadgerDB (hot-reloadable telemetry & ML parameters)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-bold text-xs shadow-cyan-500/20 transition active:scale-95"
          >
            <Save className={`w-4 h-4 ${saving ? 'animate-spin' : ''}`} />
            <span>{saving ? 'Saving...' : 'Save Changes'}</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2 text-xs font-medium">
        <button
          onClick={() => setActiveTab('thresholds')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
            activeTab === 'thresholds'
              ? 'bg-slate-800 text-cyan-400 font-semibold border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Thresholds & ML Screening</span>
        </button>

        <button
          onClick={() => setActiveTab('llm')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
            activeTab === 'llm'
              ? 'bg-slate-800 text-cyan-300 font-semibold border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Bot className="w-4 h-4" />
          <span>Multi-Agent LLM Setup</span>
        </button>

        <button
          onClick={() => setActiveTab('display')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
            activeTab === 'display'
              ? 'bg-slate-800 text-emerald-400 font-semibold border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>Display & Telemetry Overlays</span>
        </button>
      </div>

      {/* Thresholds & ML Parameters Tab */}
      {activeTab === 'thresholds' && (
        <div className="space-y-6">
          <div className="p-6 rounded-md bg-slate-900/60 border border-slate-800 space-y-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Golden Signals Thresholds (RED Alerts)
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs font-mono">
              {/* Error Rate Warning */}
              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60 space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-slate-300 font-medium">Error Rate Warning</label>
                  <span className="text-amber-400 font-bold">
                    {(formData.thresholds.errorRateWarning * 100).toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.2"
                  step="0.005"
                  value={formData.thresholds.errorRateWarning}
                  onChange={(e) => handleThresholdChange('errorRateWarning', parseFloat(e.target.value))}
                  className="w-full accent-amber-400 cursor-pointer"
                />
              </div>

              {/* Error Rate Critical */}
              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60 space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-slate-300 font-medium">Error Rate Critical</label>
                  <span className="text-rose-400 font-bold">
                    {(formData.thresholds.errorRateCritical * 100).toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="0.5"
                  step="0.01"
                  value={formData.thresholds.errorRateCritical}
                  onChange={(e) => handleThresholdChange('errorRateCritical', parseFloat(e.target.value))}
                  className="w-full accent-rose-500 cursor-pointer"
                />
              </div>

              {/* Latency Warning */}
              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60 space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-slate-300 font-medium">P95 Latency Warning</label>
                  <span className="text-amber-400 font-bold">
                    {(formData.thresholds.latencyWarning * 1000).toFixed(0)} ms
                  </span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="2.0"
                  step="0.05"
                  value={formData.thresholds.latencyWarning}
                  onChange={(e) => handleThresholdChange('latencyWarning', parseFloat(e.target.value))}
                  className="w-full accent-amber-400 cursor-pointer"
                />
              </div>

              {/* Latency Critical */}
              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60 space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-slate-300 font-medium">P95 Latency Critical</label>
                  <span className="text-rose-400 font-bold">
                    {(formData.thresholds.latencyCritical * 1000).toFixed(0)} ms
                  </span>
                </div>
                <input
                  type="range"
                  min="0.2"
                  max="5.0"
                  step="0.1"
                  value={formData.thresholds.latencyCritical}
                  onChange={(e) => handleThresholdChange('latencyCritical', parseFloat(e.target.value))}
                  className="w-full accent-rose-500 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* ML Anomaly Pipeline Detection Parameters */}
          <div className="p-6 rounded-md bg-slate-900/60 border border-slate-800 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Two-Stage Machine Learning Parameters
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60">
                <span className="text-slate-400 text-[10px] block">Isolation Forest Cutoff</span>
                <span className="text-cyan-400 font-bold text-sm">0.75</span>
                <p className="text-[11px] text-slate-400 mt-1">Stage 1 screening threshold</p>
              </div>

              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60">
                <span className="text-slate-400 text-[10px] block">Confidence Gate</span>
                <span className="text-emerald-400 font-bold text-sm">0.92</span>
                <p className="text-[11px] text-slate-400 mt-1">Fast-tracks directly past LSTM</p>
              </div>

              <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60">
                <span className="text-slate-400 text-[10px] block">LSTM Autoencoder</span>
                <span className="text-cyan-300 font-medium text-sm">Z-Score &gt; 3.0</span>
                <p className="text-[11px] text-slate-400 mt-1">Temporal verification cutoff</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Agent LLM Tab */}
      {activeTab === 'llm' && (
        <div className="space-y-4">
          <div className="p-4 rounded-md bg-slate-900 border border-slate-700 text-xs font-mono text-slate-300">
            <strong>Hot-reloadable LLM settings:</strong> Each agent role can use a tailored model
            (e.g. ultra-fast Groq for evidence gathering, and OpenAI GPT-4o or Gemini 1.5 Pro for comprehensive RCA synthesis).
          </div>

          <div className="border border-slate-800 rounded-md overflow-hidden bg-slate-900/60">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-800/60 text-slate-400 border-b border-slate-800 text-[10px] uppercase">
                  <tr>
                    <th className="p-3">Agent Role</th>
                    <th className="p-3">Provider</th>
                    <th className="p-3">Model</th>
                    <th className="p-3">Temperature</th>
                    <th className="p-3">Max Tokens</th>
                    <th className="p-3">Fallback</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {agentConfigs.map((ag, idx) => (
                    <tr key={ag.role} className="hover:bg-slate-800/30">
                      <td className="p-3 font-semibold text-slate-200">{ag.role}</td>
                      <td className="p-3">
                        <select
                          value={ag.provider}
                          onChange={(e) => handleAgentConfigChange(idx, 'provider', e.target.value)}
                          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-cyan-300 text-xs font-mono focus:outline-none focus:border-cyan-500"
                        >
                          <option value="groq">Groq</option>
                          <option value="gemini">Gemini</option>
                          <option value="openai">OpenAI</option>
                          <option value="ollama">Ollama (Local)</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <input
                          type="text"
                          value={ag.model}
                          onChange={(e) => handleAgentConfigChange(idx, 'model', e.target.value)}
                          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-slate-200 text-xs font-mono w-44 focus:outline-none focus:border-cyan-500"
                        />
                      </td>
                      <td className="p-3">
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          value={ag.temperature}
                          onChange={(e) => handleAgentConfigChange(idx, 'temperature', parseFloat(e.target.value))}
                          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-slate-200 text-xs font-mono w-16 focus:outline-none focus:border-cyan-500"
                        />
                      </td>
                      <td className="p-3">
                        <input
                          type="number"
                          step="512"
                          min="1024"
                          max="16384"
                          value={ag.maxTokens}
                          onChange={(e) => handleAgentConfigChange(idx, 'maxTokens', parseInt(e.target.value))}
                          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-slate-200 text-xs font-mono w-20 focus:outline-none focus:border-cyan-500"
                        />
                      </td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 text-[10px] uppercase font-semibold">
                          {ag.fallbackProvider}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Display & Overlays Tab */}
      {activeTab === 'display' && (
        <div className="p-6 rounded-md bg-slate-900/60 border border-slate-800 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            UI & Telemetry Display Toggles
          </h3>

          <div className="space-y-3 font-mono text-xs">
            <label className="flex items-center justify-between p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 cursor-pointer hover:bg-slate-800/60 transition">
              <div>
                <span className="text-slate-200 font-medium block">Show Protocol Statistics</span>
                <span className="text-[11px] text-slate-400">Display gRPC & HTTP/1.1 badges on edges and nodes</span>
              </div>
              <input
                type="checkbox"
                checked={formData.display.showProtocolStats}
                onChange={(e) => handleDisplayChange('showProtocolStats', e.target.checked)}
                className="w-4 h-4 accent-cyan-400 rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 cursor-pointer hover:bg-slate-800/60 transition">
              <div>
                <span className="text-slate-200 font-medium block">Show Kubernetes Metadata</span>
                <span className="text-[11px] text-slate-400">Attach Pod names and container labels to traces & logs</span>
              </div>
              <input
                type="checkbox"
                checked={formData.display.showK8sMetadata}
                onChange={(e) => handleDisplayChange('showK8sMetadata', e.target.checked)}
                className="w-4 h-4 accent-cyan-400 rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 cursor-pointer hover:bg-slate-800/60 transition">
              <div>
                <span className="text-slate-200 font-medium block">Show Live Annotations</span>
                <span className="text-[11px] text-slate-400">Highlight sudden latency anomalies directly on topology graph</span>
              </div>
              <input
                type="checkbox"
                checked={formData.display.showAnnotations}
                onChange={(e) => handleDisplayChange('showAnnotations', e.target.checked)}
                className="w-4 h-4 accent-cyan-400 rounded cursor-pointer"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
};
