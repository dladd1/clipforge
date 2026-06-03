const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR);

const jobs = {};
let jc = 0;

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'clipforge.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.json({ status: 'ClipForge Backend Running ⚡', version: '1.0', note: 'Upload clipforge.html to serve the frontend' });
  }
});

app.get('/health', async (req, res) => {
  const ytdlp  = await checkTool('yt-dlp');
  const ffmpeg = await checkTool('ffmpeg');
  res.json({ ok: true, tools: { ytdlp, ffmpeg } });
});

// ── Create clip ───────────────────────────────────────────────────────────────
app.post('/clip', async (req, res) => {
  const { videoUrl, startTime, endTime, title, platform, caption } = req.body;
  if (!videoUrl || !startTime || !endTime)
    return res.status(400).json({ error: 'Missing videoUrl, startTime or endTime' });

  const jobId = 'j' + (++jc) + '_' + Date.now();
  jobs[jobId] = { status:'queued', progress:0, message:'Queued', file:null, error:null };
  res.json({ jobId });
  processClip(jobId, videoUrl, startTime, endTime, title||'clip', platform||'tiktok', caption||'');
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Download ──────────────────────────────────────────────────────────────────
app.get('/download/:filename', (req, res) => {
  const fp = path.join(CLIPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp);
});

// ── Processing ────────────────────────────────────────────────────────────────
async function processClip(jobId, videoUrl, startTime, endTime, title, platform, caption) {
  const job = jobs[jobId];
  try {
    const safe     = title.replace(/[^a-z0-9]/gi,'_').slice(0,35);
    const rawFile  = path.join(os.tmpdir(), jobId + '_raw.mp4');
    const clipFile = path.join(CLIPS_DIR, safe + '_' + jobId.slice(1,6) + '.mp4');
    const startSec = toSec(startTime);
    const duration = toSec(endTime) - startSec;
    if (duration <= 0) throw new Error('Start time must be before end time');

    // Step 1 — Download
    job.status = 'downloading'; job.progress = 5; job.message = 'Downloading video…';
    await run('yt-dlp', [
      '-f', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', rawFile, '--no-playlist', videoUrl
    ], line => {
      const m = line.match(/(\d+\.?\d*)%/);
      if (m) { job.progress = 5 + Math.round(parseFloat(m[1]) * 0.55); job.message = 'Downloading ' + m[1] + '%'; }
    });

    if (!fs.existsSync(rawFile)) throw new Error('Download failed — video may be private or unavailable');

    // Step 2 — Cut + style
    job.status = 'processing'; job.progress = 62; job.message = 'Cutting & adding captions…';
    const vertical = ['tiktok','instagram_reel','youtube_short'].includes(platform);
    const vf = buildVideoFilter(vertical, caption);

    await run('ffmpeg', [
      '-ss', String(startSec), '-i', rawFile,
      '-t', String(duration),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', clipFile
    ], line => {
      const m = line.match(/time=(\d+:\d+:\d+)/);
      if (m) { const d=toSec(m[1]); job.progress=62+Math.round((d/duration)*33); job.message='Processing '+Math.round((d/duration)*100)+'%'; }
    });

    try { fs.unlinkSync(rawFile); } catch(e) {}
    if (!fs.existsSync(clipFile)) throw new Error('ffmpeg did not produce output file');

    const size = (fs.statSync(clipFile).size/1024/1024).toFixed(1) + ' MB';
    job.status = 'done'; job.progress = 100;
    job.message = 'Complete! (' + size + ')';
    job.file = path.basename(clipFile);
    job.filesize = size;

  } catch(e) {
    job.status = 'error'; job.error = e.message; job.message = 'Failed: ' + e.message;
    try { fs.unlinkSync(path.join(os.tmpdir(), jobId+'_raw.mp4')); } catch(err) {}
  }
}

function buildVideoFilter(vertical, caption) {
  const parts = [];
  if (vertical) {
    parts.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1');
  } else {
    parts.push('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
  }
  if (caption && caption.trim()) {
    const txt = caption.replace(/'/g,"").replace(/:/g,"\\:").replace(/,/g,"\\,").replace(/\[|\]/g,"").slice(0,100);
    const fontSize = vertical ? 54 : 44;
    const yPos = vertical ? 'h-280' : 'h-150';
    parts.push(
      `drawtext=text='${txt}':fontsize=${fontSize}:fontcolor=white:` +
      `borderw=4:bordercolor=black@0.8:` +
      `x=(w-text_w)/2:y=${yPos}:` +
      `box=1:boxcolor=black@0.35:boxborderw=12`
    );
  }
  return parts.join(',');
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio:['ignore','pipe','pipe'] });
    p.stdout.on('data', d => onLine && onLine(d.toString()));
    p.stderr.on('data',  d => onLine && onLine(d.toString()));
    p.on('close', code => code===0 ? resolve() : reject(new Error(cmd+' exited with code '+code)));
    p.on('error', e => reject(new Error(e.code==='ENOENT' ? cmd+' not installed' : e.message)));
  });
}

function checkTool(name) {
  return new Promise(r => exec(name+' --version', e => r(!e)));
}

function toSec(t) {
  if (!t) return 0;
  const p = String(t).split(':').map(Number);
  if (p.length===3) return p[0]*3600+p[1]*60+p[2];
  if (p.length===2) return p[0]*60+p[1];
  return Number(t)||0;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('\n⚡ ClipForge backend running on port', PORT);
  Promise.all([checkTool('yt-dlp'), checkTool('ffmpeg')]).then(([y,f]) => {
    console.log('yt-dlp:', y ? '✓' : '✗ missing — run: pip install yt-dlp');
    console.log('ffmpeg:', f ? '✓' : '✗ missing');
  });
});
