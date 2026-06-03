import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('App render error:', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-slate-900 px-4 gap-4">
          <AlertCircle className="h-12 w-12 text-rose-400" />
          <h1 className="text-xl font-bold text-white">Something went wrong</h1>
          <p className="text-slate-400 text-sm text-center max-w-md">
            {this.state.error?.message || 'An unexpected error stopped the app.'}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
          >
            <RefreshCw size={16} />
            Reload page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
