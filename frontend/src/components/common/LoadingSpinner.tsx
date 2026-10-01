import React from 'react';

interface LoadingSpinnerProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  message = 'Loading live telemetry...',
  size = 'md',
}) => {
  const sizeClasses = {
    sm: 'w-5 h-5 border-2',
    md: 'w-8 h-8 border-2',
    lg: 'w-12 h-12 border-3',
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 gap-3">
      <div className="relative">
        <div
          className={`${sizeClasses[size]} rounded-full border-cyan-500/20 border-t-cyan-400 animate-spin`}
        />
        <div className="absolute inset-0 rounded-full bg-cyan-400/20 blur-md -z-10 animate-pulse" />
      </div>
      {message && <p className="text-xs text-slate-400 font-mono tracking-wide">{message}</p>}
    </div>
  );
};
