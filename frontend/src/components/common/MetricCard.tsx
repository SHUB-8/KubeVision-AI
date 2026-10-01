import React, { ReactNode } from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  unit?: string;
  icon?: ReactNode;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
  status?: 'normal' | 'warning' | 'critical';
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  unit,
  icon,
  subtitle,
  status = 'normal',
}) => {
  let borderGlow = 'border-slate-800 hover:border-slate-700 bg-slate-900/60';
  let valueColor = 'text-slate-100';

  if (status === 'warning') {
    borderGlow = 'border-amber-500/30 hover:border-amber-500/50 bg-amber-950/10';
    valueColor = 'text-amber-300';
  } else if (status === 'critical') {
    borderGlow = 'border-rose-500/30 hover:border-rose-500/50 bg-rose-950/10';
    valueColor = 'text-rose-300';
  }

  return (
    <div
      className={`p-4 rounded-md border transition-all duration-200 ${borderGlow}`}
    >
      <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
        <span className="font-medium uppercase tracking-wider">{title}</span>
        {icon && <span className="text-slate-400">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl font-bold font-mono tracking-tight ${valueColor}`}>
          {value}
        </span>
        {unit && <span className="text-xs text-slate-400 font-mono">{unit}</span>}
      </div>
      {subtitle && (
        <div className="mt-1.5 text-[11px] text-slate-400 truncate">
          {subtitle}
        </div>
      )}
    </div>
  );
};
