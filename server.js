import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import { ssim } from 'ssim.js';
import pLimit from 'p-limit';
import rateLimit from 'express-rate-limit';
import { config } from 'dotenv';
config({ quiet: true });
import pg from 'pg';
import bcrypt from 'bcrypt';
import session from 'express-session';
import crypto from 'crypto';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
// Connects to the Postgres database using the URL from your .env / Railway variables
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
}));
// Creates the users table if it doesn't already exist — runs safely every time the server starts
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      stripe_customer_id TEXT,
      is_pro BOOLEAN DEFAULT FALSE,	
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT FALSE
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT
  `);
  console.log('Database ready.');
}
initDb().catch((err) => console.error('Database setup failed:', err));
const FREE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const PRO_MAX_SIZE = 200 * 1024 * 1024; // 200MB

const upload = multer({ dest: 'uploads/', limits: { files: 100, fileSize: PRO_MAX_SIZE } });
// A single secret key for now — anyone calling the API must send this
// In real use you'd store this somewhere safer than plain code, but this works for v1
const API_KEY = process.env.API_KEY || 'dev-test-key-12345';

// Limits each caller to 20 requests per minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, slow down.' },
});

// Middleware: checks for a valid API key before letting a request through
// Middleware: blocks access unless the visitor is logged in
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}
async function requireApiKey(req, res, next) {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  try {
    const result = await db.query('SELECT id, is_pro FROM users WHERE api_key = $1', [providedKey]);
    const user = result.rows[0];

    if (!user || !user.is_pro) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    req.apiUserId = user.id; // stash this for later use in the route
    next();
  } catch (err) {
    console.error('API key check failed:', err);
    res.status(500).json({ error: 'Something went wrong verifying your API key.' });
  }
}

// Converts an image buffer into raw RGBA pixel data — this is what ssim.js needs to compare images
async function getRawImageData(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

// Encodes an image at a given quality, using the RIGHT encoder for its actual format
async function encodeAtQuality(inputPath, format, quality) {
  const image = sharp(inputPath);

  if (format === 'jpeg') {
    return image.jpeg({ quality }).toBuffer();
  }
  if (format === 'png') {
    // palette:true is what makes sharp do pngquant-style color quantization instead of lossless PNG
    return image.png({ quality, palette: true }).toBuffer();
  }
  if (format === 'webp') {
    return image.webp({ quality }).toBuffer();
  }

  // Fallback for anything unexpected — just re-encode as JPEG
  return image.jpeg({ quality }).toBuffer();
}

// Tries a list of quality levels for the DETECTED format, returns the first one that's visually similar enough
function renderPage(title, bodyHtml, userEmail) {
const authLinks = userEmail
    ? `<a href="/account">Account</a> <form action="/logout" method="post" style="display:inline;"><button type="submit" style="background:none;color:var(--safelight);padding:0;font-size:12px;text-transform:none;letter-spacing:0;">Log out</button></form>`
    : `<a href="/login">Log in</a> <a href="/signup">Sign up</a>`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --page:#EFE8D8; --card:#FAF6EB; --ink:#23190F;
    --safelight:#C2472B; --safelight-tint:#F5DCD2;
    --fixer:#4B7A61; --fixer-tint:#DEEAE1;
    --line:#DDD2B8; --dim:#8D8271;
  }
  *{box-sizing:border-box;}
  body{
    margin:0; background:var(--page); color:var(--ink);
    font-family:'Inter',sans-serif; min-height:100vh;
    display:flex; align-items:center; justify-content:center;
    padding:48px 20px;
    background-image: radial-gradient(circle at 1px 1px, rgba(35,25,15,0.05) 1px, transparent 0);
    background-size: 22px 22px;
  }
  .card{
    width:100%; max-width:600px; background:var(--card);
    border:1px solid var(--line); border-radius:3px; padding:44px;
    position:relative;
    box-shadow: 0 1px 2px rgba(35,25,15,0.04), 0 8px 24px rgba(35,25,15,0.06);
  }
  .card::before{
    content:''; position:absolute; top:0; left:32px; right:32px; height:2px;
    background:linear-gradient(90deg, transparent, var(--safelight), transparent);
    opacity:.6;
  }
  .eyebrow{
    font-family:'IBM Plex Mono',monospace; font-size:10.5px;
    letter-spacing:.16em; text-transform:uppercase; color:var(--safelight);
    margin:0 0 10px;
  }
  h1{
    font-family:'Instrument Serif', serif; font-weight:400;
    font-size:38px; line-height:1.05; margin:0 0 10px; letter-spacing:-0.01em;
    color:var(--ink);
  }
  p.lead{ color:var(--dim); font-size:14px; margin:0 0 30px; line-height:1.55; max-width:46ch;}
  .dropzone{
    border:1px dashed var(--line); border-radius:3px; padding:40px 22px;
    text-align:center; background:var(--page);
  }
  input[type=file]{ display:block; margin:0 auto 18px; color:var(--dim); font-size:12.5px; font-family:'IBM Plex Mono',monospace;}
  button{
    background:var(--safelight); color:var(--card); border:none;
    font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:12.5px;
    letter-spacing:.04em; text-transform:uppercase;
    padding:13px 26px; border-radius:3px; cursor:pointer;
    transition:background .15s ease;
  }
  button:hover{ background:#a83a23; }
  button:disabled{ opacity:.55; cursor:default; }
  .stat-row{ display:flex; justify-content:space-between; align-items:baseline; padding:13px 0; border-bottom:1px solid var(--line); font-family:'IBM Plex Mono',monospace;}
  .stat-row:last-child{ border-bottom:none; }
  .stat-label{ font-size:10.5px; color:var(--dim); text-transform:uppercase; letter-spacing:.1em;}
  .stat-value{ font-family:'Instrument Serif',serif; font-size:19px; color:var(--ink);}
  .savings-badge{
    display:inline-flex; align-items:center; gap:6px;
    background:var(--fixer-tint); color:var(--fixer);
    font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:12px;
    letter-spacing:.03em; padding:6px 13px; border-radius:3px; margin-bottom:22px;
  }
  .savings-badge::before{ content:'●'; font-size:8px; }
  .preview{ width:100%; border-radius:3px; border:1px solid var(--line); margin-top:14px; display:block;}
  a.button-link{
    display:inline-block; margin-top:26px; color:var(--safelight);
    text-decoration:none; font-family:'IBM Plex Mono',monospace; font-size:12.5px; font-weight:600;
    letter-spacing:.03em;
  }
  a.button-link:hover{ text-decoration:underline; }
  .frame{
    position:relative; border:1px solid var(--line); border-radius:3px;
    padding:18px 18px 18px 22px; margin-bottom:16px; background:var(--page);
  }
  .frame::before{
    content:''; position:absolute; left:0; top:0; bottom:0; width:10px;
    background-image: radial-gradient(circle, var(--card) 2px, transparent 2.4px);
    background-size: 10px 14px; background-position: center;
    border-right:1px solid var(--line);
  }
  .frame-number{
    font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--safelight);
    letter-spacing:.08em; margin-bottom:6px; margin-left:8px;
  }
  .frame-name{ font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--dim); margin-left:8px; word-break:break-all;}
.page-wrap{ width:100%; max-width:600px; }
  .site-header{
    display:flex; justify-content:space-between; align-items:center;
    margin-bottom:22px;
  }
  .logo{ height:26px; display:block; }
  .site-nav{ display:flex; gap:22px; }
  .site-nav a{
    font-family:'IBM Plex Mono',monospace; font-size:12px; font-weight:500;
    letter-spacing:.02em; color:var(--dim); text-decoration:none;
  }
  .site-nav a:hover{ color:var(--safelight); }

.plan{
    border:1px solid var(--line); border-radius:3px; padding:22px;
    margin-bottom:14px; background:var(--page);
  }
  .plan-name{ font-family:'Instrument Serif',serif; font-size:22px; margin:0 0 4px; }
  .plan-price{ font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--safelight); margin:0 0 14px; }
  .plan ul{ margin:0; padding-left:18px; font-size:13.5px; color:var(--dim); line-height:1.9; }
  .field-input{
    width:100%; padding:11px 12px; margin-bottom:12px;
    background:var(--page); border:1px solid var(--line); border-radius:3px;
    color:var(--ink); font-family:'Inter',sans-serif; font-size:13.5px;
  }
  textarea.field-input{ resize:vertical; min-height:100px; }

</style>
</head>
<body>
  <div class="page-wrap">
    <header class="site-header">
      <a href="/" class="logo-link"><img src="/logo.png" alt="SquashImage" class="logo" /></a>
      <nav class="site-nav">  
        <a href="/">Compress</a>
        <a href="/pricing">Pricing</a>
        <a href="/upcoming">Upcoming</a>
        <a href="/contact">Contact</a>
        ${authLinks}
      </nav>
	</header>
    <div style="text-align:center; margin-bottom:28px;">
      <h2 style="font-family:'Instrument Serif',serif; font-weight:400; font-size:32px; color:var(--ink); margin:0 0 6px; line-height:1.15;">Fast and easy compression.</h2>
      <p style="font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--safelight); margin:0;">API included in Pro</p>
    </div>
    <div class="card">${bodyHtml}</div>
    <p style="text-align:center; font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--dim); margin-top:24px;">Built by a solo developer — be nice 🙂</p>
  </div>
</body>
</html>`;
}
async function compressWithSSIM(inputPath, targetSimilarity = 0.985, resizeOpts = null) {
  const metadata = await sharp(inputPath).metadata();
  const format = metadata.format; // e.g. 'jpeg', 'png', 'webp'

  console.log('Detected format:', format);

  const originalBuffer = fs.readFileSync(inputPath);

  // If resizing was requested, resize FIRST — everything downstream compares
  // against this resized version, not the original dimensions
  let workingInput = inputPath;
  if (resizeOpts && (resizeOpts.width || resizeOpts.height)) {
    workingInput = await sharp(inputPath)
      .resize(resizeOpts.width || null, resizeOpts.height || null, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
    console.log('Resized to fit within', resizeOpts.width || '-', 'x', resizeOpts.height || '-');
  }

  const referenceRaw = await getRawImageData(workingInput);

  const qualities = [90, 80, 70, 60, 50, 40, 30];
  let result = null;

  for (const quality of qualities) {
    const compressedBuffer = await encodeAtQuality(workingInput, format, quality);
    const compressedRaw = await getRawImageData(compressedBuffer);

    const { mssim } = ssim(referenceRaw, compressedRaw);

    console.log('  tried quality', quality, '-> similarity', mssim.toFixed(4));

    result = { buffer: compressedBuffer, quality, similarity: mssim, format };

    if (mssim >= targetSimilarity) {
      break;
    }
  }
// Safety check: never return something bigger than the original file
  if (result.buffer.length >= originalBuffer.length) {
    return {
      buffer: originalBuffer,
      quality: 100,
      similarity: 1,
      format,
      note: 'original was already well-optimized, kept as-is',
    };
  }

  return result;}

// Homepage — shows a simple upload form
app.get('/', (req, res) => {
  res.send(renderPage('Image Compressor', `
    <h1>Image Compressor</h1>
    <p class="lead">Drop in a JPEG, PNG, or WebP — it'll find the smallest file size that still looks right, automatically.</p>
    <form action="/compress" method="post" enctype="multipart/form-data">
      <div class="dropzone">
       <div id="dropArea" style="cursor:pointer;">
          <div style="display:flex; justify-content:center; gap:6px; margin-bottom:14px;">
            <div style="width:34px; height:34px; border:1.5px solid var(--line); border-radius:4px; background:var(--card); transform:rotate(-6deg);"></div>
            <div style="width:34px; height:34px; border:1.5px solid var(--safelight); border-radius:4px; background:var(--card);"></div>
            <div style="width:34px; height:34px; border:1.5px solid var(--line); border-radius:4px; background:var(--card); transform:rotate(6deg);"></div>
          </div>
         <p style="font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--ink); margin:0 0 6px; font-weight:500;">Drop multiple images here</p>
          <p style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--dim); margin:0 0 14px;">or click to browse — JPEG, PNG, WebP</p>
          <input type="file" name="images" accept="image/*,.heic,.heif" multiple required style="display:none;" />
        </div>
        <div style="margin:16px 0; text-align:left;">
          <div id="originalDims" style="font-size:12px; color:#9aa1ad; margin-bottom:10px; display:none;"></div>
          <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px;">
            <label style="display:flex; align-items:center; gap:5px; font-size:13px; color:#9aa1ad;">
              <input type="radio" name="preset" value="" checked> Original size
            </label>
            <label style="display:flex; align-items:center; gap:5px; font-size:13px; color:#9aa1ad;">
              <input type="radio" name="preset" value="1920"> Large (1920px)
            </label>
            <label style="display:flex; align-items:center; gap:5px; font-size:13px; color:#9aa1ad;">
              <input type="radio" name="preset" value="1080"> Medium (1080px)
            </label>
            <label style="display:flex; align-items:center; gap:5px; font-size:13px; color:#9aa1ad;">
              <input type="radio" name="preset" value="640"> Small (640px)
            </label>
            <label style="display:flex; align-items:center; gap:5px; font-size:13px; color:#9aa1ad;">
              <input type="radio" name="preset" value="custom"> Custom
            </label>
          </div>
          <input type="number" id="customSize" placeholder="Max dimension (px)" style="display:none; width:160px; padding:8px; background:#0f1115; border:1px solid #262b35; border-radius:6px; color:#eef0f4; font-size:13px;" />
        </div>
        <input type="hidden" name="width" id="hiddenWidth" />
        <input type="hidden" name="height" id="hiddenHeight" />
        <button type="submit">Compress image</button>
      </div>
    </form>
    <script src="https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js"></script>
    <script>
      const form = document.querySelector('form');
      const fileInput = document.querySelector('input[type=file]');
      const button = document.querySelector('button');

      form.addEventListener('submit', async function (e) {
        const file = fileInput.files[0];
        if (!file) return;

        const isHeic =
          file.type === 'image/heic' ||
          file.type === 'image/heif' ||
          file.name.toLowerCase().endsWith('.heic') ||
          file.name.toLowerCase().endsWith('.heif');

        if (!isHeic) return;

        e.preventDefault();
        button.textContent = 'Converting HEIC...';
        button.disabled = true;

        try {
          const convertedBlob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
          const convertedFile = new File(
            [convertedBlob],
            file.name.replace(/\.(heic|heif)$/i, '.jpg'),
            { type: 'image/jpeg' }
          );

          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(convertedFile);
          fileInput.files = dataTransfer.files;

          button.textContent = 'Compress image';
          button.disabled = false;
          form.submit();
        } catch (err) {
          console.error('HEIC conversion failed', err);
          alert('Could not convert this HEIC file. Try a different photo.');
          button.textContent = 'Compress image';
          button.disabled = false;
        }
      });
    </script>
	<script>
      const dropArea = document.getElementById('dropArea');

      const realFileInput = document.querySelector('input[type=file]');

      dropArea.addEventListener('click', () => realFileInput.click());

      dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropArea.style.borderColor = 'var(--safelight)';
      });

      dropArea.addEventListener('dragleave', () => {
        dropArea.style.borderColor = '';
      });

      dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.style.borderColor = '';
        realFileInput.files = e.dataTransfer.files;
        realFileInput.dispatchEvent(new Event('change'));
      });
    

      const fileInputForDims = document.querySelector('input[type=file]');
      const originalDimsEl = document.getElementById('originalDims');
      const hiddenWidth = document.getElementById('hiddenWidth');
      const hiddenHeight = document.getElementById('hiddenHeight');
      const customSizeInput = document.getElementById('customSize');
      const presetRadios = document.querySelectorAll('input[name=preset]');

      fileInputForDims.addEventListener('change', function () {
        const file = fileInputForDims.files[0];
        if (!file) return;
        const img = new Image();
        img.onload = function () {
          originalDimsEl.textContent = 'Original: ' + img.naturalWidth + ' × ' + img.naturalHeight + 'px';
          originalDimsEl.style.display = 'block';
        };
        img.src = URL.createObjectURL(file);
      });

      function applyPreset() {
        const selected = document.querySelector('input[name=preset]:checked').value;
        if (selected === '') {
          hiddenWidth.value = '';
          hiddenHeight.value = '';
          customSizeInput.style.display = 'none';
        } else if (selected === 'custom') {
          customSizeInput.style.display = 'block';
          hiddenWidth.value = customSizeInput.value;
          hiddenHeight.value = customSizeInput.value;
        } else {
          customSizeInput.style.display = 'none';
          hiddenWidth.value = selected;
          hiddenHeight.value = selected;
        }
      }

      presetRadios.forEach(function (radio) {
        radio.addEventListener('change', applyPreset);
      });
      customSizeInput.addEventListener('input', function () {
        hiddenWidth.value = customSizeInput.value;
        hiddenHeight.value = customSizeInput.value;
      });
    </script>
  `, req.session.userEmail));
});
// Signup page
app.get('/signup', (req, res) => {
  res.send(renderPage('Sign Up', `
    <p class="eyebrow">Create account</p>
    <h1>Sign up</h1>
    <form action="/signup" method="post">
      <input class="field-input" type="email" name="email" placeholder="Email" required />
      <input class="field-input" type="password" name="password" placeholder="Password (min 8 characters)" minlength="8" required />
      <button type="submit">Create account</button>
    </form>
    <p class="lead" style="margin-top:16px;">Already have an account? <a class="button-link" href="/login" style="margin-top:0;">Log in</a></p>
  `, req.session.userEmail));
});

// Handles signup form submission
app.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password || password.length < 8) {
      return res.status(400).send(renderPage('Sign Up', `
        <h1>Sign up</h1>
        <p class="lead">Email and a password (min 8 characters) are required.</p>
        <a class="button-link" href="/signup">← Try again</a>
      `, req.session.userEmail));
    }

    // Hash the password — bcrypt does the heavy lifting; we NEVER store the real password
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );

    // Log them in immediately after signup
    req.session.userId = result.rows[0].id;
    req.session.userEmail = result.rows[0].email;

    res.redirect('/');
  } catch (err) {
    if (err.code === '23505') {
      // Postgres's error code for "unique constraint violated" — this email is already registered
      return res.status(400).send(renderPage('Sign Up', `
        <h1>Sign up</h1>
        <p class="lead">That email is already registered.</p>
        <a class="button-link" href="/login">Log in instead →</a>
      `, req.session.userEmail));
    }
    console.error(err);
    res.status(500).send(renderPage('Sign Up', `
      <h1>Something went wrong</h1>
      <a class="button-link" href="/signup">← Try again</a>
    `, req.session.userEmail));
  }
});
// Login page
app.get('/login', (req, res) => {
  res.send(renderPage('Log In', `
    <p class="eyebrow">Welcome back</p>
    <h1>Log in</h1>
    <form action="/login" method="post">
      <input class="field-input" type="email" name="email" placeholder="Email" required />
      <input class="field-input" type="password" name="password" placeholder="Password" required />
      <button type="submit">Log in</button>
    </form>
    <p class="lead" style="margin-top:16px;">No account yet? <a class="button-link" href="/signup" style="margin-top:0;">Sign up</a></p>
  `, req.session.userEmail));
});

// Handles login form submission
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // Deliberately vague error message — never reveal whether it was the email or password that was wrong
    const genericError = () => res.status(401).send(renderPage('Log In', `
      <h1>Log in</h1>
      <p class="lead">Incorrect email or password.</p>
      <a class="button-link" href="/login">← Try again</a>
    `, req.session.userEmail));

    if (!user) return genericError();

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) return genericError();

    req.session.userId = user.id;
    req.session.userEmail = user.email;

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send(renderPage('Log In', `
      <h1>Something went wrong</h1>
      <a class="button-link" href="/login">← Try again</a>
    `, req.session.userEmail));
  }
});

// Logout — destroys the session
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});
// Starts a Stripe Checkout session — redirects the logged-in user to Stripe's hosted payment page
app.post('/create-checkout-session', requireLogin, async (req, res) => {
  try {
    const userResult = await db.query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [req.session.userId]);
    const user = userResult.rows[0];

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.session.userId]);
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.protocol}://${req.get('host')}/account?checkout=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/pricing?checkout=cancelled`,
    });

    res.redirect(checkoutSession.url);
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).send('Something went wrong starting checkout.');
  }
});
// Account page — shows Pro status and API key if applicable
app.get('/account', requireLogin, async (req, res) => {
  const result = await db.query('SELECT email, is_pro, api_key FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];

  const proSection = user.is_pro
    ? `
      <div class="stat-row">
        <span class="stat-label">Plan</span>
        <span class="stat-value">Pro</span>
      </div>
      <div style="margin-top:20px;">
        <span class="stat-label">Your API key</span>
	<div style="background:var(--page); border:1px solid var(--line); border-radius:3px; padding:12px; margin-top:8px; font-family:'IBM Plex Mono',monospace; font-size:12.5px; word-break:break-all;">${user.api_key}</div>
      </div>
      <form action="/create-portal-session" method="post" style="margin-top:20px;">
        <button type="submit">Manage subscription</button>
      </form>
    `
    : `
      <div class="stat-row">
        <span class="stat-label">Plan</span>
        <span class="stat-value">Free</span>
      </div>
      <a class="button-link" href="/pricing">Upgrade to Pro →</a>
    `;

  res.send(renderPage('Account', `
    <p class="eyebrow">Your account</p>
    <h1>${user.email}</h1>
    ${proSection}
  `, req.session.userEmail));
});
// Sends a logged-in Pro user to Stripe's hosted subscription management page
app.post('/create-portal-session', requireLogin, async (req, res) => {
  try {
    const userResult = await db.query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.session.userId]);
    const user = userResult.rows[0];

    if (!user.stripe_customer_id) {
      return res.redirect('/pricing');
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${req.protocol}://${req.get('host')}/account`,
    });

    res.redirect(portalSession.url);
  } catch (err) {
    console.error('Portal session error:', err);
    res.status(500).send('Something went wrong opening your subscription settings.');
  }
});
// Pricing page
app.get('/pricing', (req, res) => {
  res.send(renderPage('Pricing', `
    <p class="eyebrow">Pricing</p>
    <h1>Simple, usage-based</h1>
    <p class="lead">Start free. Upgrade when you need batches, larger files, or API access.</p>

    <div class="plan">
      <p class="plan-name">Free</p>
      <p class="plan-price">$0 / month</p>
      <ul>
        <li>Single image compression</li>
        <li>JPEG, PNG, WebP support</li>
        <li>Resize presets</li>
      </ul>
    </div>

    <div class="plan">
      <p class="plan-name">Pro</p>
      <p class="plan-price">$3 / month</p>
      <ul>
        <li>Batch upload (up to 100 images)</li>
        <li>API access with your own key</li>
        <li>Priority processing</li>
      </ul>
        <form action="/create-checkout-session" method="post">
        <button type="submit">Subscribe — $3/mo</button>
      </form>
    </div>

    <a class="button-link" href="/">← Back</a>
  `, req.session.userEmail));
});

// Upcoming features page
app.get('/upcoming', (req, res) => {
  res.send(renderPage('Upcoming Features', `
    <p class="eyebrow">Roadmap</p>
    <h1>What's next</h1>
    <p class="lead">Things actively planned for SquashImage.</p>
    <div class="stat-row"><span class="stat-label">Video compression</span></div>
    <div class="stat-row"><span class="stat-label">AVIF format support</span></div>
    <div class="stat-row"><span class="stat-label">CLI tool</span></div>
    <div class="stat-row"><span class="stat-label">Automatic site-wide compression (CDN)</span></div>
    <a class="button-link" href="/">← Back</a>
  `, req.session.userEmail));
});

// Contact page — shows the form
app.get('/contact', (req, res) => {
  res.send(renderPage('Contact', `
    <p class="eyebrow">Get in touch</p>
    <h1>Contact us</h1>
    <p class="lead">Questions, bugs, or feature requests — send them here.</p>
    <form action="/contact" method="post">
      <input class="field-input" type="text" name="name" placeholder="Your name" required />
      <input class="field-input" type="email" name="email" placeholder="Your email" required />
      <textarea class="field-input" name="message" placeholder="Your message" required></textarea>
      <button type="submit">Send message</button>
    </form>
  `, req.session.userEmail));
});

// Contact page — handles the form submission
app.post('/contact', async (req, res) => {
  console.log('New contact form submission:', req.body);

  try {
    await resend.emails.send({
      from: 'SquashImage <onboarding@resend.dev>',
      to: 'christianjamesnicholaswalker@gmail.com', // <-- put YOUR real inbox here
      subject: 'New contact form message',
      text: `From: ${req.body.name} (${req.body.email})\n\n${req.body.message}`,
    });
  } catch (err) {
    console.error('Failed to send contact email:', err);
    // Don't block the user's confirmation page just because email sending failed
  }

  res.send(renderPage('Message sent', `
    <p class="eyebrow">Thanks</p>
    <h1>Message received</h1>
    <p class="lead">We'll get back to you soon.</p>
    <a class="button-link" href="/">← Back</a>
  `, req.session.userEmail));
});
// This runs when someone submits the form above
app.post('/compress', upload.array('images', 100), async (req, res) => {
  try {
    // Check whether this visitor is a Pro subscriber
    let isPro = false;
    if (req.session.userId) {
      const userResult = await db.query('SELECT is_pro FROM users WHERE id = $1', [req.session.userId]);
      isPro = userResult.rows[0]?.is_pro || false;
    }

    // Free tier: single image only
    if (!isPro && req.files.length > 1) {
      req.files.forEach(f => fs.unlinkSync(f.path));
      return res.status(403).send(renderPage('Upgrade Required', `
        <h1>Batch upload is a Pro feature</h1>
        <p class="lead">Free accounts can compress one image at a time. Upgrade to Pro for batch upload.</p>
        <a class="button-link" href="/pricing">See Pro plans \u2192</a>
      `, req.session.userEmail));
    }

    // Free tier: 10MB per file limit
    const maxSize = isPro ? PRO_MAX_SIZE : FREE_MAX_SIZE;
    const oversized = req.files.find(f => f.size > maxSize);
    if (oversized) {
      req.files.forEach(f => fs.unlinkSync(f.path));
      return res.status(403).send(renderPage('File Too Large', `
        <h1>File too large</h1>
        <p class="lead">Free accounts are limited to 10MB per image. Upgrade to Pro for files up to 200MB.</p>
        <a class="button-link" href="/pricing">See Pro plans \u2192</a>
      `, req.session.userEmail));
    }

    const width = parseInt(req.body.width) || null;
    const height = parseInt(req.body.height) || null;
    const resizeOpts = (width || height) ? { width, height } : null;

    const mimeTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const results = [];

// Process up to 3 images at once instead of one at a time — real speedup on multi-core machines
    const limit = pLimit(5);

    const compressOne = async (file) => {
      const { buffer, quality, similarity, format } = await compressWithSSIM(file.path, 0.985, resizeOpts);

      console.log(
        file.originalname, '- compressed as', format,
        '- quality:', quality,
        '- similarity:', similarity.toFixed(4),
        '- size:', buffer.length, 'bytes'
      );

      const originalSize = fs.statSync(file.path).size;
      fs.unlinkSync(file.path);

      return {
        name: file.originalname,
        originalSize,
        compressedSize: buffer.length,
        savedPercent: Math.round((1 - buffer.length / originalSize) * 100),
        base64: buffer.toString('base64'),
        mime: mimeTypes[format] || 'image/jpeg',
      };
    };

    const batchResults = await Promise.all(
      req.files.map((file) => limit(() => compressOne(file)))
    );
    results.push(...batchResults);
    const totalOriginal = results.reduce((sum, r) => sum + r.originalSize, 0);
    const totalCompressed = results.reduce((sum, r) => sum + r.compressedSize, 0);
    const totalSavedPercent = Math.round((1 - totalCompressed / totalOriginal) * 100);

    const resultCards = results.map(r => `
      <div style="border-bottom:1px solid var(--border); padding:20px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <span style="font-size:13px; color:var(--dim);">${r.name}</span>
          <span style="font-size:12.5px; font-weight:600; color:var(--accent);">${r.savedPercent}% smaller</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Original</span>
          <span class="stat-value">${(r.originalSize / 1024).toFixed(0)} KB</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Compressed</span>
          <span class="stat-value">${(r.compressedSize / 1024).toFixed(0)} KB</span>
        </div>
          <img class="preview" src="data:${r.mime};base64,${r.base64}" alt="${r.name}" />
        <a class="button-link" href="data:${r.mime};base64,${r.base64}" download="compressed-${r.name}">↓ Download</a>
      </div>
    `).join('');

    res.send(renderPage('Compressed', `
      <div class="savings-badge">${totalSavedPercent}% smaller overall</div>
      <h1>${results.length} image${results.length > 1 ? 's' : ''} compressed</h1>
      <p class="lead">${(totalOriginal / 1024).toFixed(0)} KB → ${(totalCompressed / 1024).toFixed(0)} KB total.</p>
      ${resultCards}
      <a class="button-link" href="/">← Compress more</a>
    `, req.session.userEmail));
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong compressing those images.');
  }
});
// JSON API endpoint — same compression logic, returns data instead of an HTML page
app.post('/api/compress', apiLimiter, requireApiKey, upload.array('images', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded. Send files under the "images" field.' });
    }

    const width = parseInt(req.body.width) || null;
    const height = parseInt(req.body.height) || null;
    const resizeOpts = (width || height) ? { width, height } : null;

    const mimeTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const limit = pLimit(5);

    const compressOne = async (file) => {
      const { buffer, quality, similarity, format } = await compressWithSSIM(file.path, 0.985, resizeOpts);
      const originalSize = fs.statSync(file.path).size;
      fs.unlinkSync(file.path);

      return {
        name: file.originalname,
        format,
        quality,
        similarity: Number(similarity.toFixed(4)),
        originalSize,
        compressedSize: buffer.length,
        savedPercent: Math.round((1 - buffer.length / originalSize) * 100),
        mime: mimeTypes[format] || 'image/jpeg',
        data: buffer.toString('base64'),
      };
    };

    const results = await Promise.all(
      req.files.map((file) => limit(() => compressOne(file)))
    );

    const totalOriginal = results.reduce((sum, r) => sum + r.originalSize, 0);
    const totalCompressed = results.reduce((sum, r) => sum + r.compressedSize, 0);

    res.json({
      success: true,
      count: results.length,
      totalOriginalSize: totalOriginal,
      totalCompressedSize: totalCompressed,
      totalSavedPercent: Math.round((1 - totalCompressed / totalOriginal) * 100),
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong compressing those images.' });
  }
});

// Stripe calls this automatically when a payment event happens (e.g. a subscription succeeds)
// IMPORTANT: this must receive the raw request body, not JSON-parsed — Stripe verifies the signature against raw bytes
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerId = session.customer;

    // Generate a personal API key for this newly-Pro user
      const personalApiKey = 'sqi_' + crypto.randomBytes(24).toString('hex');

    await db.query(
      'UPDATE users SET is_pro = TRUE, api_key = $1 WHERE stripe_customer_id = $2',
      [personalApiKey, customerId]
    );

    console.log('User upgraded to Pro:', customerId);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    await db.query(
      'UPDATE users SET is_pro = FALSE, api_key = NULL WHERE stripe_customer_id = $1',
      [customerId]
    );

    console.log('User downgraded from Pro:', customerId);
  }

  res.json({ received: true });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT);
});
