// MemCare auth middleware — terminal-style login (cookie session)
// Credentials & secret read from CF Pages env vars: USERS_JSON, SESSION_SECRET

const COOKIE_NAME = 'memcare_session';
const SESSION_MAX_AGE = 604800; // 7 days

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemCare</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a; color: #00ff41;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    min-height: 100vh;
  }
  .terminal {
    border: 1px solid #333; padding: 2rem;
    max-width: 420px; width: 90%;
    background: #0d0d0d;
    box-shadow: 0 0 20px rgba(0,255,65,0.05);
  }
  .terminal-bar {
    display: flex; gap: 6px; margin-bottom: 1.5rem;
    padding-bottom: 0.8rem; border-bottom: 1px solid #222;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot-r { background: #ff5f56; }
  .dot-y { background: #ffbd2e; }
  .dot-g { background: #27c93f; }
  h1 { font-size: 0.85rem; font-weight: normal; margin-bottom: 1.2rem; color: #666; }
  h1 span { color: #6c5ce7; }
  .prompt { color: #6c5ce7; margin-bottom: 0.4rem; font-size: 0.8rem; }
  input {
    width: 100%; background: transparent; border: none;
    border-bottom: 1px solid #333; color: #e8e6f0;
    font-family: inherit; font-size: 0.85rem;
    padding: 0.5rem 0; margin-bottom: 1rem; outline: none;
    caret-color: #6c5ce7;
  }
  input::placeholder { color: #333; }
  input:focus { border-bottom-color: #6c5ce7; }
  input:-webkit-autofill,
  input:-webkit-autofill:hover,
  input:-webkit-autofill:focus {
    -webkit-text-fill-color: #e8e6f0;
    -webkit-box-shadow: 0 0 0px 1000px #0d0d0d inset;
    transition: background-color 5000s ease-in-out 0s;
  }
  button {
    background: transparent; border: 1px solid #6c5ce7;
    color: #6c5ce7; font-family: inherit; font-size: 0.8rem;
    padding: 0.5rem 1.5rem; cursor: pointer; margin-top: 0.5rem;
  }
  button:hover { background: #6c5ce7; color: #0a0a0a; }
  .error { color: #ff5f56; font-size: 0.75rem; margin-bottom: 0.8rem; }
  .blink { animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div class="terminal">
  <div class="terminal-bar"><div class="dot dot-r"></div><div class="dot dot-y"></div><div class="dot dot-g"></div></div>
  <h1><span>Mem</span>Care</h1>
  ${error ? '<div class="error">✗ ' + error + '</div>' : ''}
  <form method="POST" action="/__auth/login">
    <div class="prompt">$ user<span class="blink">_</span></div>
    <input type="text" name="user" autocomplete="username" placeholder="..." autofocus required>
    <div class="prompt">$ pass<span class="blink">_</span></div>
    <input type="password" name="pass" autocomplete="current-password" placeholder="..." required>
    <button type="submit">LOGIN →</button>
  </form>
</div>
<footer style="text-align:center;padding:1.5rem 0 1rem;font-size:0.65rem">
  <a href="https://openclawd.co" target="_blank" rel="noopener" style="color:#555;text-decoration:none">Tinker Lab / 折腾实验室</a>
</footer>
</body>
</html>`;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

async function makeToken(secret, timestamp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp));
  return timestamp + '.' + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '');
}

async function verifyToken(secret, token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const ts = token.slice(0, dot);
  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > SESSION_MAX_AGE * 1000) return false;
  const expected = await makeToken(secret, ts);
  return token === expected;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Read auth config from env (Pages env vars). Fail closed if missing.
  let USERS, SESSION_SECRET;
  try {
    USERS = JSON.parse(env.USERS_JSON);
    SESSION_SECRET = env.SESSION_SECRET;
    if (!USERS || !SESSION_SECRET) throw new Error('missing');
  } catch (e) {
    return new Response('Auth not configured', { status: 503 });
  }

  // Allow favicon through without auth
  if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
    return context.next();
  }

  // Handle login POST
  if (request.method === 'POST' && url.pathname === '/__auth/login') {
    const form = await request.formData();
    const user = form.get('user');
    const pass = form.get('pass');
    if (USERS[user] === pass) {
      const ts = Date.now().toString();
      const token = await makeToken(SESSION_SECRET, ts);
      return new Response('', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`,
        },
      });
    }
    return new Response(loginPage('Invalid credentials'), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Handle logout
  if (url.pathname === '/__auth/logout') {
    return new Response('', {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Check session cookie
  const cookie = parseCookie(request.headers.get('Cookie'), COOKIE_NAME);
  const valid = await verifyToken(SESSION_SECRET, cookie);

  // Also accept Basic Auth (for API/curl access)
  if (!valid) {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Basic ')) {
      try {
        const decoded = atob(auth.slice(6));
        const idx = decoded.indexOf(':');
        if (idx !== -1 && USERS[decoded.slice(0, idx)] === decoded.slice(idx + 1)) {
          return context.next();
        }
      } catch {}
    }
  }

  if (!valid) {
    return new Response(loginPage(''), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const resp = await context.next();
  const newResp = new Response(resp.body, resp);
  newResp.headers.set('Cache-Control', 'no-store');
  return newResp;
}
