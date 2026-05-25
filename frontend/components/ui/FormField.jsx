import React from 'react';
import { AlertCircle } from 'lucide-react';

const FormField = ({
  label,
  id,
  type = 'text',
  value,
  onChange,
  error,
  hint,
  required = false,
  disabled = false,
  autoComplete,
  placeholder,
  minLength,
  children,
}) => (
  <div>
    {label && (
      <label htmlFor={id} className="block text-sm font-medium text-slate-300">
        {label}
        {required && <span className="text-rose-400 ml-1">*</span>}
      </label>
    )}
    <div className="mt-1">
      {children || (
        <input
          id={id}
          name={id}
          type={type}
          value={value}
          onChange={onChange}
          required={required}
          disabled={disabled}
          autoComplete={autoComplete}
          placeholder={placeholder}
          minLength={minLength}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`appearance-none block w-full px-3 py-2 border rounded-md shadow-sm bg-slate-900 text-white sm:text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-50 ${
            error
              ? 'border-rose-500 focus:ring-rose-500 focus:border-rose-500'
              : 'border-slate-600 focus:ring-emerald-500 focus:border-emerald-500'
          }`}
        />
      )}
    </div>
    {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    {error && (
      <p id={`${id}-error`} className="mt-1 text-xs text-rose-400 flex items-center gap-1">
        <AlertCircle size={12} />
        {error}
      </p>
    )}
  </div>
);

export default FormField;
