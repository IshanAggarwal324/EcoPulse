import React, { useState } from 'react';
import { X, ChevronRight, ChevronLeft, FileText, Zap, Globe, User, Mail } from 'lucide-react';

const PERIODS = [
  { value: '7d', label: '7 Days', sub: 'Weekly snapshot' },
  { value: '14d', label: '14 Days', sub: 'Fortnightly' },
  { value: '30d', label: '30 Days', sub: 'Monthly overview' },
];

const SCOPES = [
  { value: 'personal', label: 'My Activity', icon: User, desc: 'Wallet energy and profit' },
  { value: 'grid', label: 'Grid Only', icon: Globe, desc: 'Grid-wide stats' },
  { value: 'both', label: 'Both', icon: Zap, desc: 'Personal + grid combined' },
];

const DELIVERIES = [
  { value: 'chat', label: 'Summary in Chat', icon: FileText, desc: 'Quick read right here', disabled: false },
  { value: 'email', label: 'Email PDF', icon: Mail, desc: 'Detailed report to your email', disabled: false },
];

const StepIndicator = ({ step, total }) => (
  <div className="flex items-center gap-1.5">
    {Array.from({ length: total }, (_, i) => (
      <div
        key={i}
        className={`h-1 rounded-full transition-all ${
          i === step ? 'w-6 bg-emerald-400' : i < step ? 'w-4 bg-emerald-500/40' : 'w-4 bg-slate-700'
        }`}
      />
    ))}
  </div>
);

const OptionCard = ({ selected, onClick, label, sub, icon: Icon, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`w-full text-left p-3 rounded-xl border transition-all ${
      disabled
        ? 'border-slate-700/40 bg-slate-800/30 opacity-50 cursor-not-allowed'
        : selected
          ? 'border-emerald-500/50 bg-emerald-500/10 ring-1 ring-emerald-500/30'
          : 'border-slate-700/50 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/60'
    }`}
  >
    <div className="flex items-center gap-3">
      {Icon && <Icon size={18} className={selected ? 'text-emerald-400' : 'text-slate-400'} />}
      <div className="min-w-0">
        <p className={`text-sm font-medium ${selected ? 'text-emerald-300' : 'text-slate-200'}`}>
          {label}
          {disabled && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-slate-700 rounded text-slate-400 uppercase tracking-wider">
              Soon
            </span>
          )}
        </p>
        {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  </button>
);

const ReportWizardModal = ({ open, onClose, onConfirm }) => {
  const [step, setStep] = useState(0);
  const [period, setPeriod] = useState('7d');
  const [scope, setScope] = useState('both');
  const [delivery, setDelivery] = useState('chat');

  if (!open) return null;

  const TOTAL_STEPS = 3;

  const handleBack = () => setStep((s) => Math.max(0, s - 1));

  const handleNext = () => {
    if (step < TOTAL_STEPS - 1) {
      setStep((s) => s + 1);
    } else {
      onConfirm({ period, scope, delivery });
      setStep(0);
    }
  };

  const stepContent = [
    <div className="space-y-2">
      <p className="text-xs text-slate-400 mb-3">Select report period</p>
      {PERIODS.map((p) => (
        <OptionCard
          key={p.value}
          selected={period === p.value}
          onClick={() => setPeriod(p.value)}
          label={p.label}
          sub={p.sub}
        />
      ))}
    </div>,

    <div className="space-y-2">
      <p className="text-xs text-slate-400 mb-3">What should the report cover?</p>
      {SCOPES.map((s) => (
        <OptionCard
          key={s.value}
          selected={scope === s.value}
          onClick={() => setScope(s.value)}
          label={s.label}
          sub={s.desc}
          icon={s.icon}
        />
      ))}
    </div>,

    <div className="space-y-2">
      <p className="text-xs text-slate-400 mb-3">How would you like to receive it?</p>
      {DELIVERIES.map((d) => (
        <OptionCard
          key={d.value}
          selected={delivery === d.value}
          onClick={() => setDelivery(d.value)}
          label={d.label}
          sub={d.desc}
          icon={d.icon}
          disabled={d.disabled}
        />
      ))}
    </div>,
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-100">Generate Report</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4">
          <StepIndicator step={step} total={TOTAL_STEPS} />
          <div className="mt-4">{stepContent[step]}</div>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
          <button
            type="button"
            onClick={step === 0 ? onClose : handleBack}
            className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white transition-colors"
          >
            {step === 0 ? 'Cancel' : (
              <>
                <ChevronLeft size={14} className="inline -mt-0.5" />
                Back
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleNext}
            className="px-4 py-1.5 text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-colors"
          >
            {step === TOTAL_STEPS - 1 ? 'Generate' : (
              <>
                Next
                <ChevronRight size={14} className="inline -mt-0.5 ml-0.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default React.memo(ReportWizardModal);
