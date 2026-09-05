// A complete, self-contained login page: no external stylesheet, no script,
// no asset that lives behind the auth gate. Everything the page needs is
// inlined here so it renders correctly even before the browser has a
// session. Colour tokens are copied from public/styles.css to match the
// rest of the app's look.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLoginPage({ error = null } = {}) {
  const errorBlock = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub Analytics</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7;
    --surface-1: #fcfcfb;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --border: rgba(11, 11, 11, 0.10);
    --border-strong: rgba(11, 11, 11, 0.20);
    --btn-bg: #1c5cab;
    --btn-ink: #ffffff;
    --critical: #a11f1f;
    --focus: #2a78d6;
    --radius: 10px;
    --radius-sm: 6px;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --page: #0d0d0d;
      --surface-1: #1a1a19;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --border: rgba(255, 255, 255, 0.10);
      --border-strong: rgba(255, 255, 255, 0.22);
      --btn-bg: #3987e5;
      --btn-ink: #0d0d0d;
      --critical: #e66767;
      --focus: #3987e5;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface-1: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --border: rgba(255, 255, 255, 0.10);
    --border-strong: rgba(255, 255, 255, 0.22);
    --btn-bg: #3987e5;
    --btn-ink: #0d0d0d;
    --critical: #e66767;
    --focus: #3987e5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--page);
    color: var(--text-primary);
    font-family: var(--sans);
  }
  main.login {
    width: 100%;
    max-width: 22rem;
    margin: 1.5rem;
    padding: 2rem;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  h1 {
    margin: 0 0 0.35rem;
    font-size: 1.15rem;
    font-weight: 600;
  }
  p.tagline {
    margin: 0 0 1.5rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  label {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 0.4rem;
  }
  input[type="password"] {
    width: 100%;
    padding: 0.6rem 0.7rem;
    font-size: 1rem;
    font-family: inherit;
    color: var(--text-primary);
    background: var(--page);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  input[type="password"]:focus {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  button {
    display: block;
    width: 100%;
    margin-top: 1.1rem;
    padding: 0.65rem 0.7rem;
    font-size: 1rem;
    font-weight: 600;
    font-family: inherit;
    color: var(--btn-ink);
    background: var(--btn-bg);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  p.error {
    margin: 0 0 1rem;
    padding: 0.6rem 0.7rem;
    color: var(--critical);
    background: rgba(161, 31, 31, 0.08);
    border: 1px solid var(--critical);
    border-radius: var(--radius-sm);
    font-size: 0.88rem;
  }
</style>
</head>
<body>
<main class="login">
  <h1>GitHub Analytics</h1>
  <p class="tagline">Enter the passphrase to continue.</p>
  ${errorBlock}
  <form method="POST" action="/login">
    <label for="password">Passphrase</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`;
}
