// Error boundaries for the Settings window. Without one, any error while drawing unmounts the whole
// React tree and the window shows only its dark background ("Settings turned black"). With them, a
// broken panel shows a small notice, a broken page keeps the section list usable, and the window as a
// whole offers a reload. Every catch is written to ui-errors.json (core/uiErrors.ts).
import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError, formatUiError, reportUiError } from "../core/uiErrors";
import { getSettings } from "../core/settings/store";
import { resolveLang, translate } from "./i18n";

type Variant = "panel" | "page" | "window";

interface Props {
  /** where in the window, for the log ("settings/page:ai") */
  where: string;
  variant: Variant;
  /** a change (e.g. another section picked) clears the error and draws again */
  resetKey?: unknown;
  children?: ReactNode;
}
interface State {
  error: unknown;
  components?: string;
  key?: unknown;
  copied: boolean;
}

const COPY: Record<Variant, string> = {
  panel: "This part of Settings hit a problem.",
  page: "This page of Settings hit a problem. The other sections still work.",
  window: "Settings hit a problem.",
};

/** Interface language without hooks (the fallback must draw even when hooks are what broke). */
const tr = (text: string): string => {
  try {
    return translate(resolveLang(getSettings().app.uiLanguage), text);
  } catch {
    return text;
  }
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("Unknown error") };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Remember the key the error happened under; a new key means "try again".
    if (state.error && state.key === undefined) return { key: props.resetKey };
    if (state.error && props.resetKey !== state.key) return { error: null, components: undefined, key: undefined, copied: false };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ components: info.componentStack ?? undefined });
    reportUiError(this.props.where, error, info.componentStack ?? undefined);
  }

  private retry = () => this.setState({ error: null, components: undefined, key: undefined, copied: false });

  private copy = () => {
    const d = describeError(this.state.error);
    void navigator.clipboard
      ?.writeText(formatUiError({ where: this.props.where, at: Date.now(), ...d, components: this.state.components }))
      .then(() => this.setState({ copied: true }))
      .catch(() => undefined);
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { variant } = this.props;
    const d = describeError(this.state.error);
    return (
      <div className={`crash crash-${variant}`} role="alert">
        <p className="crash-title">{tr(COPY[variant])}</p>
        <div className="inline">
          {variant === "window" ? (
            <button className="btn primary" onClick={() => location.reload()}>
              {tr("Reload Settings")}
            </button>
          ) : (
            <button className="btn" onClick={this.retry}>
              {tr("Try again")}
            </button>
          )}
          <button className="btn quiet" onClick={this.copy}>
            {tr(this.state.copied ? "Copied" : "Copy details")}
          </button>
        </div>
        <details className="crash-details">
          <summary>{tr("Details")}</summary>
          <pre>{d.message}</pre>
        </details>
      </div>
    );
  }
}
