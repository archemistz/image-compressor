import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import { ssim } from 'ssim.js';
import pLimit from 'p-limit';
import rateLimit from 'express-rate-limit';

const app = express();
const upload = multer({ dest: 'uploads/', limits: { files: 50 } });
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
function requireApiKey(req, res, next) {
  const providedKey = req.headers['x-api-key'];
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
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
function renderPage(title, bodyHtml) {
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
</style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
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
	<input type="file" name="images" accept="image/*,.heic,.heif" multiple required />
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
  `));
});
// This runs when someone submits the form above
app.post('/compress', upload.array('images', 50), async (req, res) => {
  try {

const width = parseInt(req.body.width) || null;
    const height = parseInt(req.body.height) || null;
    const resizeOpts = (width || height) ? { width, height } : null;

    const mimeTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const results = [];

// Process up to 3 images at once instead of one at a time — real speedup on multi-core machines
    const limit = pLimit(3);

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
      </div>
    `).join('');

    res.send(renderPage('Compressed', `
      <div class="savings-badge">${totalSavedPercent}% smaller overall</div>
      <h1>${results.length} image${results.length > 1 ? 's' : ''} compressed</h1>
      <p class="lead">${(totalOriginal / 1024).toFixed(0)} KB → ${(totalCompressed / 1024).toFixed(0)} KB total.</p>
      ${resultCards}
      <a class="button-link" href="/">← Compress more</a>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong compressing those images.');
  }
});
// JSON API endpoint — same compression logic, returns data instead of an HTML page
app.post('/api/compress', apiLimiter, requireApiKey, upload.array('images', 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded. Send files under the "images" field.' });
    }

    const width = parseInt(req.body.width) || null;
    const height = parseInt(req.body.height) || null;
    const resizeOpts = (width || height) ? { width, height } : null;

    const mimeTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const limit = pLimit(3);

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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT);
});
