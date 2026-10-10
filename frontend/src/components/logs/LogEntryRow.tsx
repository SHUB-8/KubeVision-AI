import React, { useState } from 'react';
import { LogEntry } from '../../types/api';
import { Copy, Check, Terminal, AlertCircle } from 'lucide-react';

interface LogEntryRowProps {
  entry: LogEntry;
  rawMode?: boolean;
}

export const LogEntryRow: React.FC<LogEntryRowProps> = ({ entry, rawMode }) => {
  const [copied, setCopied] = useState(false);

  const copyLine = () => {
    navigator.clipboard.writeText(entry.line);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Detect log level
  let level = 'INFO';
  let levelBadgeColor = 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20';

  const lineLower = entry.line.toLowerCase();
  if (lineLower.includes('error') || lineLower.includes('fail') || lineLower.includes('fatal') || lineLower.includes('panic')) {
    level = 'ERROR';
    levelBadgeColor = 'text-rose-400 bg-rose-500/10 border-rose-500/30 font-bold';
  } else if (lineLower.includes('warn')) {
    level = 'WARN';
    levelBadgeColor = 'text-amber-400 bg-amber-500/10 border-amber-500/30';
  } else if (lineLower.includes('debug')) {
    level = 'DEBUG';
    levelBadgeColor = 'text-slate-400 bg-slate-800 border-slate-700';
  }

  // Parse JSON if possible
  let displayMessage = entry.line;
  let parsedJson: any = null;
  if (!rawMode) {
    try {
      parsedJson = JSON.parse(entry.line);
      if (parsedJson.log) {
        displayMessage = parsedJson.log.trim();
      } else if (parsedJson.message) {
        displayMessage = parsedJson.message;
      }
    } catch {
      // not json
    }
  }

  // Format timestamp (nanoseconds to date)
  let formattedTime = 'Recent';
  try {
    const tsNum = Number(entry.timestamp);
    if (!isNaN(tsNum)) {
      const ms = tsNum > 1e15 ? tsNum / 1e6 : tsNum;
      formattedTime = new Date(ms).toLocaleTimeString();
    }
  } catch {
    // fallback
  }

  const podName = entry.labels?.kubernetes_pod_name || entry.labels?.pod || entry.stream || 'pod';

  return (
    <div className="group flex items-start gap-3 px-3 py-2 hover:bg-slate-800/40 text-xs font-mono transition border-b border-slate-800/40">
      {/* Timestamp */}
      <span className="text-slate-400 text-[10px] whitespace-nowrap shrink-0 pt-0.5 select-none">
        {formattedTime}
      </span>

      {/* Level Badge */}
      <span
        className={`px-1.5 py-0.2 text-[9px] rounded font-mono border uppercase tracking-wider shrink-0 ${levelBadgeColor}`}
      >
        {level}
      </span>

      {/* Pod badge */}
      <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700/60 truncate max-w-[140px] shrink-0">
        {podName}
      </span>

      {/* Log message */}
      <div className="flex-1 break-all text-slate-200 leading-relaxed overflow-hidden">
        {displayMessage}
      </div>

      {/* Copy button */}
      <button
        onClick={copyLine}
        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-cyan-400 rounded transition shrink-0"
        title="Copy log line"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
};
