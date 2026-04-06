import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly hasError: boolean;
  readonly error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900 p-6">
          <div className="max-w-lg w-full rounded-xl border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              The page crashed due to an unexpected error. Try refreshing the page.
            </p>
            <pre className="text-xs bg-gray-100 dark:bg-gray-900 rounded-lg p-3 overflow-x-auto text-red-700 dark:text-red-300 mb-4 max-h-40 overflow-y-auto">
              {this.state.error?.message}{'\n'}{this.state.error?.stack?.split('\n').slice(1, 5).join('\n')}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
