import React, { useState, useEffect } from 'react';
import { Star, X } from 'lucide-react';

const MAX_COMMENT = 500;

const RatingModal = ({ open, onClose, onSubmit, tradeTxHash, ratedWallet, listingId }) => {
  const [score, setScore] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setScore(0);
      setHover(0);
      setComment('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setError('');
    if (!score || score < 1 || score > 5) {
      setError('Please select a star rating');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        score,
        comment: comment.slice(0, MAX_COMMENT),
        tradeTxHash,
        ratedWallet,
        listingId,
      });
      onClose();
    } catch (e) {
      setError(e?.message || 'Failed to submit rating');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="glass-card w-full max-w-md rounded-2xl p-6 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-slate-500 hover:text-white"
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <h3 className="text-white font-semibold text-lg mb-1">Rate this seller</h3>
        <p className="text-slate-500 text-sm mb-4">
          Share your experience after a verified trade.
        </p>

        <div className="flex gap-1 mb-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <button
              key={i}
              type="button"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setScore(i)}
              className="p-1"
              aria-label={`${i} star${i === 1 ? '' : 's'}`}
            >
              <Star
                size={28}
                className={
                  (hover || score) >= i
                    ? 'text-amber-400 fill-amber-400'
                    : 'text-slate-600'
                }
              />
            </button>
          ))}
        </div>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={MAX_COMMENT}
          placeholder="Optional comment (max 500 chars)"
          className="w-full bg-slate-900/60 text-white text-sm rounded-xl border border-slate-700 p-3 mb-2 focus:outline-none focus:border-emerald-500/50"
          rows={3}
        />
        <div className="text-right text-[10px] text-slate-600 mb-3">
          {comment.length}/{MAX_COMMENT}
        </div>

        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-xl text-slate-400 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 rounded-xl bg-emerald-600/80 hover:bg-emerald-500/80 disabled:opacity-50 text-white font-medium"
          >
            {submitting ? 'Submitting…' : 'Submit rating'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RatingModal;
