import { Component } from "react";

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const isZh = document.documentElement.lang !== "en";
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--sd-page,#f7f5ef)] p-6 text-center text-[var(--sd-text,#292823)]">
        <section className="w-full max-w-md">
          <h1 className="text-xl font-black">{isZh ? "页面资源需要更新" : "This page needs an update"}</h1>
          <p className="mt-3 text-sm text-[var(--sd-muted,#69675f)]">
            {isZh ? "页面版本已经更新，请重新加载后继续。" : "A newer page version is available. Reload to continue."}
          </p>
          <button
            type="button"
            className="mt-6 rounded-lg bg-[var(--sd-primary,#c56b23)] px-5 py-2.5 text-sm font-bold text-white"
            onClick={() => window.location.reload()}
          >
            {isZh ? "重新加载" : "Reload"}
          </button>
        </section>
      </main>
    );
  }
}

export default AppErrorBoundary;
