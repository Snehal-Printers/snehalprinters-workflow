# Frontend build note

`app.jsx` is the source (React, JSX syntax). `app.js` is what's actually loaded
by `index.html` — it's a **precompiled**, plain-JavaScript version with all JSX
already converted to `React.createElement(...)` calls.

We do it this way instead of loading `app.jsx` with `type="text/babel"` +
Babel Standalone in the browser, because that in-browser-transform approach is
unreliable in production (MIME/XHR/CDN quirks — Babel's own docs warn against
using it for anything but quick demos) and was causing
`SyntaxError: Cannot use import statement outside a module` for some visitors.

## If you edit app.jsx, rebuild app.js before deploying

```bash
npm install --no-save @babel/core @babel/preset-react
node -e "
const babel = require('@babel/core');
const fs = require('fs');
const src = fs.readFileSync('app.jsx', 'utf8');
const out = babel.transformSync(src, {
  presets: [['@babel/preset-react', { runtime: 'classic' }]],
  filename: 'app.jsx',
});
fs.writeFileSync('app.js', out.code);
"
```

Run that from inside `pages/assets/`, then `wrangler pages deploy .` as usual.
No other build step, no bundler, no node_modules shipped to production.
