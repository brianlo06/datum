import { Home } from "./pages/Home";
import { PartPage } from "./pages/PartPage";
import { Publish } from "./pages/Publish";
import { Link, useRoute } from "./router";

export default function App() {
  const route = useRoute();

  return (
    <div className="shell">
      <header className="masthead">
        <Link to="/" className="brand">
          <span className="mark">◱</span> Datum
        </Link>
        <p className="tagline">
          Parts you can configure, compile and trust — the source is the artifact, the build is the
          quality gate.
        </p>
        <nav className="masthead-nav">
          <Link to="/">Parts</Link>
          <Link to="/publish" className="nav-cta">
            Publish
          </Link>
        </nav>
      </header>

      {route.name === "home" && <Home />}
      {route.name === "publish" && <Publish />}
      {route.name === "part" && <PartPage owner={route.owner} slug={route.slug} />}
      {route.name === "notFound" && (
        <div className="empty">
          <p>Nothing lives at {route.path}.</p>
          <Link to="/" className="primary">
            Back to the registry
          </Link>
        </div>
      )}
    </div>
  );
}
