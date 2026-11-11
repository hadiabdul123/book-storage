import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/literata/400.css";
import "@fontsource/literata/500.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import App from "./App";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main className="boot">
        <h1>Something interrupted your reading.</h1>
        <p>{this.state.error}</p>
        <p>Your saved library has not been cleared.</p>
        <button onClick={() => location.reload()}>Reload Leafmark</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
