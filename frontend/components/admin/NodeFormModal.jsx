import React, { useState, useEffect } from 'react';
import { X, Loader2, Server } from 'lucide-react';
import {
  NODE_TYPE_LABELS,
  SOURCE_TYPE_LABELS,
} from '../../utils/adminFormat';

const NODE_TYPES = Object.entries(NODE_TYPE_LABELS);
const SOURCE_TYPES = Object.entries(SOURCE_TYPE_LABELS);
const STATUSES = [
  ['active', 'Active'],
  ['inactive', 'Inactive'],
  ['maintenance', 'Maintenance'],
  ['failed', 'Failed'],
];

const EMPTY = {
  name: '',
  nodeType: 'producer',
  sourceType: 'solar',
  status: 'active',
  location: '',
  lat: '',
  lng: '',
  userId: '',
};

const selectClass =
  'w-full px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
const inputClass = selectClass;
const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5';

const NodeFormModal = ({ open, node, loading, onClose, onSubmit }) => {
  const isEdit = !!node;
  const [values, setValues] = useState(EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setTouched(false);
      if (node) {
        setValues({
          name: node.name || '',
          nodeType: node.nodeType || 'producer',
          sourceType: node.sourceType || 'solar',
          status: node.status || 'active',
          location: node.location || '',
          lat: node.coordinates?.lat ?? '',
          lng: node.coordinates?.lng ?? '',
          userId: '',
        });
      } else {
        setValues(EMPTY);
      }
    }
  }, [open, node]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !loading) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const set = (field) => (e) => setValues((v) => ({ ...v, [field]: e.target.value }));
  const nameInvalid = touched && !values.name.trim();

  const handleSubmit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (!values.name.trim()) return;

    const payload = {
      name: values.name.trim(),
      nodeType: values.nodeType,
      sourceType: values.sourceType,
      status: values.status,
      location: values.location.trim() || undefined,
      // Backend normalizes + range-validates; both empty clears coordinates.
      coordinates: {
        lat: values.lat.trim() === '' ? '' : Number(values.lat),
        lng: values.lng.trim() === '' ? '' : Number(values.lng),
      },
    };
    if (!isEdit && values.userId.trim()) {
      payload.userId = values.userId.trim();
    }
    onSubmit(payload);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !loading && onClose?.()}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-form-modal-title"
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto custom-scrollbar bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <h3 id="node-form-modal-title" className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <Server size={16} className="text-emerald-400" />
            {isEdit ? 'Edit node' : 'Create node'}
          </h3>
          <button
            type="button"
            onClick={() => !loading && onClose?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 py-5 space-y-4">
          <div>
            <label className={labelClass} htmlFor="nodeName">
              Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="nodeName"
              value={values.name}
              onChange={set('name')}
              disabled={loading}
              autoFocus
              placeholder="e.g. Rooftop Solar Array A"
              className={`${inputClass} ${nameInvalid ? 'border-rose-500/60' : ''}`}
            />
            {nameInvalid && <p className="text-xs text-rose-400 mt-1.5">Name is required.</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="nodeType">Node type</label>
              <select id="nodeType" value={values.nodeType} onChange={set('nodeType')} disabled={loading} className={selectClass}>
                {NODE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="sourceType">Source type</label>
              <select id="sourceType" value={values.sourceType} onChange={set('sourceType')} disabled={loading} className={selectClass}>
                {SOURCE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="nodeStatus">Status</label>
            <select id="nodeStatus" value={values.status} onChange={set('status')} disabled={loading} className={selectClass}>
              {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="nodeLocation">Location</label>
            <input
              id="nodeLocation"
              value={values.location}
              onChange={set('location')}
              disabled={loading}
              placeholder="e.g. Building B, Roof"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="nodeLat">Latitude</label>
              <input
                id="nodeLat"
                type="number"
                step="any"
                inputMode="decimal"
                value={values.lat}
                onChange={set('lat')}
                disabled={loading}
                placeholder="-90 to 90"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="nodeLng">Longitude</label>
              <input
                id="nodeLng"
                type="number"
                step="any"
                inputMode="decimal"
                value={values.lng}
                onChange={set('lng')}
                disabled={loading}
                placeholder="-180 to 180"
                className={inputClass}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-slate-500">Optional. Required for the live grid map.</p>

          {!isEdit && (
            <div>
              <label className={labelClass} htmlFor="nodeOwner">Owner user ID (optional)</label>
              <input
                id="nodeOwner"
                value={values.userId}
                onChange={set('userId')}
                disabled={loading}
                placeholder="Defaults to your account"
                className={`font-mono text-xs ${inputClass}`}
              />
              <p className="text-xs text-slate-500 mt-1">Leave blank to assign to yourself.</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white transition-colors disabled:opacity-60"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
              {isEdit ? 'Save changes' : 'Create node'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default React.memo(NodeFormModal);
