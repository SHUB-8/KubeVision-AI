import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { UISettings, ThresholdSettings, DisplaySettings } from '../../types/api';
import { LoadingSpinner } from '../common/LoadingSpinner';
import {
  Save,
  Activity,
  Layers,
} from 'lucide-react';

type ThresholdTone = 'warn' | 'crit';

/**
 * Dirty check against the persisted config, compared field by field: key order
 * and object identity must not decide whether an unchanged form looks unsaved.
 */
const isConfigDirty = (saved: UISettings, draft: UISettings): boolean =>
  saved.theme !== draft.theme ||
  saved.refreshInterval !== draft.refreshInterval ||
  saved.timeWindow !== draft.timeWindow ||
  saved.namespace !== draft.namespace ||
  (Object.keys(saved.thresholds) as (keyof ThresholdSettings)[]).some(
    (key) => saved.thresholds[key] !== draft.thresholds[key]
  ) ||
  (Object.keys(saved.display) as (keyof DisplaySettings)[]).some(
    (key) => saved.display[key] !== draft.display[key]
  );

interface ThresholdControlProps {
  id: string;
  label: string;
  /** Stored value: a request fraction for rates, seconds for latency. */
  value: number;
  min: number;
  max: number;
  step: number;
  tone: ThresholdTone;
  /** Human-readable read-out of the current value, e.g. "3.5%" or "120 ms". */
  readout: string;
  /** Unit for the min/max bounds, so the exact-value box is unambiguous. */
  unit: string;
  /** Explains the stored unit in the exact-value tooltip. */
  hint: string;
  onChange: (value: number) => void;
}

/**
 * One threshold row: slider for coarse tuning plus min/max labels and an exact
 * numeric box, so a precise value can be typed instead of dragged.
 */
const ThresholdControl: React.FC<ThresholdControlProps> = ({
  id,
  label,
  value,
  min,
  max,
  step,
  tone,
  readout,
  unit,
  hint,
  onChange,
}) => {
  // The exact-value box is uncontrolled on purpose: Chrome reports a partial
  // entry like "0." as an empty string for type="number", and a controlled
  // value would then rewrite the field on every keystroke, making decimals
  // impossible to type. The ref syncs it when the slider moves.
  const exactRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = exactRef.current;
    if (!el || document.activeElement === el) return;
    if (el.value !== String(value)) el.value = String(value);
  }, [value]);

  const commitExact = () => {
    const el = exactRef.current;
    if (!el) return;
    const parsed = parseFloat(el.value);
    // Keep the stored config inside the slider's bounds even if the number box
    // is typed past them, and revert unparseable text to the last good value.
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    el.value = String(next);
    if (next !== value) onChange(next);
  };

  // Native range tracks render with the UA's light track; style both engines'
  // tracks so the control reads dark-on-dark and the status colour stays on
  // the thumb only.
  const thumbClass =
    tone === 'warn'
      ? '[&::-webkit-slider-thumb]:bg-amber-400 [&::-moz-range-thumb]:bg-amber-400'
      : '[&::-webkit-slider-thumb]:bg-rose-400 [&::-moz-range-thumb]:bg-rose-400';
  const rangeClass = [
    'w-full h-4 cursor-pointer appearance-none bg-transparent',
    '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-sm [&::-webkit-slider-runnable-track]:bg-slate-700',
    '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-sm [&::-moz-range-track]:bg-slate-700',
    '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0',
    '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0',
    thumbClass,
  ].join(' ');

  const withUnit = (bound: number) => (unit ? `${bound} ${unit}` : String(bound));

  return (
    <div className="p-4 rounded-md bg-slate-800/40 border border-slate-700/60 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-slate-300 font-medium">
          {label}
        </label>
        <span className={`font-bold ${tone === 'warn' ? 'text-amber-400' : 'text-rose-400'}`}>
          {readout}
        </span>
      </div>

      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={rangeClass}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono text-slate-400">{withUnit(min)}</span>
        <input
          ref={exactRef}
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={value}
          aria-label={`${label} exact value`}
          title={`${label} — exact value from ${withUnit(min)} to ${withUnit(max)} (${hint})`}
          onBlur={commitExact}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className="w-24 bg-slate-900 border border-slate-700 rounded-md px-2 py-1 text-right font-mono text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
        />
        <span className="text-[10px] font-mono text-slate-400">{withUnit(max)}</span>
      </div>
    </div>
  );
};

export const SettingsView: React.FC = () => {
  const { config, updateConfigState, addToast } = useApp();
  const [formData, setFormData] = useState<UISettings | null>(config);
  const [saving, setSaving] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'thresholds' | 'display'>('thresholds');

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

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.updateConfig(formData);
      updateConfigState(updated);
      addToast('success', 'Configuration saved');
    } catch (err: any) {
      addToast('error', `Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // The page h1 names the view, so no title card repeats it; the form reports
  // instead whether it still matches the persisted config.
  const isDirty = config ? isConfigDirty(config, formData) : false;

  return (
    <div className="p-4 lg:p-8 pb-0 lg:pb-0 max-w-5xl mx-auto flex min-h-full flex-col">
      <div className="space-y-6 pb-6">
        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-slate-800 pb-2 text-xs font-medium">
          <button
            onClick={() => setActiveTab('thresholds')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
              activeTab === 'thresholds'
                ? 'bg-slate-800 text-cyan-400 font-semibold border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="w-4 h-4" />
            <span>Alert Thresholds</span>
          </button>

          <button
            onClick={() => setActiveTab('display')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
              activeTab === 'display'
                ? 'bg-slate-800 text-cyan-400 font-semibold border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Display</span>
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
                <ThresholdControl
                  id="error-rate-warning"
                  label="Error Rate Warning"
                  value={formData.thresholds.errorRateWarning}
                  min={0}
                  max={0.2}
                  step={0.005}
                  tone="warn"
                  readout={`${(formData.thresholds.errorRateWarning * 100).toFixed(1)}%`}
                  unit=""
                  hint="fraction of requests, 0.2 = 20%"
                  onChange={(val) => handleThresholdChange('errorRateWarning', val)}
                />

                <ThresholdControl
                  id="error-rate-critical"
                  label="Error Rate Critical"
                  value={formData.thresholds.errorRateCritical}
                  min={0.01}
                  max={0.5}
                  step={0.01}
                  tone="crit"
                  readout={`${(formData.thresholds.errorRateCritical * 100).toFixed(1)}%`}
                  unit=""
                  hint="fraction of requests, 0.5 = 50%"
                  onChange={(val) => handleThresholdChange('errorRateCritical', val)}
                />

                <ThresholdControl
                  id="latency-warning"
                  label="P95 Latency Warning"
                  value={formData.thresholds.latencyWarning}
                  min={0.05}
                  max={2}
                  step={0.05}
                  tone="warn"
                  readout={`${(formData.thresholds.latencyWarning * 1000).toFixed(0)} ms`}
                  unit="s"
                  hint="stored in seconds"
                  onChange={(val) => handleThresholdChange('latencyWarning', val)}
                />

                <ThresholdControl
                  id="latency-critical"
                  label="P95 Latency Critical"
                  value={formData.thresholds.latencyCritical}
                  min={0.2}
                  max={5}
                  step={0.1}
                  tone="crit"
                  readout={`${(formData.thresholds.latencyCritical * 1000).toFixed(0)} ms`}
                  unit="s"
                  hint="stored in seconds"
                  onChange={(val) => handleThresholdChange('latencyCritical', val)}
                />
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
              <label className="flex items-center justify-between p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 cursor-pointer hover:bg-slate-800/60 transition-colors">
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

              <label className="flex items-center justify-between p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 cursor-pointer hover:bg-slate-800/60 transition-colors">
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

              <label className="flex items-center justify-between p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 cursor-pointer hover:bg-slate-800/60 transition-colors">
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

      {/* Save bar — pinned to the viewport bottom while the form scrolls, so
          the dirty state and the single save action stay in reach. */}
      <div className="sticky bottom-0 z-10 -mx-4 lg:-mx-8 mt-auto px-4 lg:px-8 py-3 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-mono" role="status">
          {isDirty ? (
            <span className="text-amber-400">Unsaved changes</span>
          ) : (
            <span className="text-slate-400">All changes saved</span>
          )}
        </p>

        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-500 text-slate-950 font-bold text-xs transition-colors enabled:hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-400 disabled:cursor-not-allowed"
        >
          <Save className={`w-4 h-4 ${saving ? 'animate-spin' : ''}`} />
          <span>{saving ? 'Saving...' : 'Save Changes'}</span>
        </button>
      </div>
    </div>
  );
};
