const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR);

const jobs = {};
let jc = 0;

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'clipforge.html');
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.json({ status: 'ClipForge Backend Running ⚡', version: '1.0' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, tools: { ytdlp: true, ffmpeg: true } });
});

app.post('/clip', async (req, res) => {
  const { videoUrl, startTime, endTime, title, platform, caption } = req.body;
  if (!videoUrl || !startTime || !endTime)
    return res.status(400).json({ error: 'Missing videoUrl, startTime or endTime' });
  const jobId = 'j' + (++jc) + '_' + Date.now();
  jobs[jobId] = { status: 'queued', progress: 0, message: 'Queued', file: null, error: null };
  res.json({ jobId });
  processClip(jobId, videoUrl, startTime, endTime, title || 'clip', platform || 'tiktok', caption || '');
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

app.get('/download/:filename', (req, res) => {
  const fp = path.join(CLIPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp);
});

async function processClip(jobId, videoUrl, startTime, endTime, title, platform, caption) {
  const job = jobs[jobId];
  try {
    const safe = title.replace(/[^a-z0-9]/gi, '_').slice(0, 35);
    const rawFile = path.join(os.tmpdir(), jobId + '_raw.mp4');
    const clipFile = path.join(CLIPS_DIR, safe + '_' + jobId.slice(1, 6) + '.mp4');
    const startSec = toSec(startTime);
    const duration = toSec(endTime) - startSec;
    if (duration <= 0) throw new Error('Start must be before end');

    job.status = 'downloading'; job.progress = 5; job.message = 'Downloading video...';
    await run('yt-dlp', [
      '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', rawFile, '--no-playlist', videoUrl
    ], line => {
      const m = line.match(/(\d+\.?\d*)%/);
      if (m) { job.progress = 5 + Math.round(parseFloat(m[1]) * 0.55); job.message = 'Downloading ' + m[1] + '%'; }
    });

    if (!fs.existsSync(rawFile)) throw new Error('Download failed');

    job.status = 'processing'; job.progress = 62; job.message = 'Cutting clip...';
    const vertical = ['tiktok', 'instagram_reel', 'youtube_short'].includes(platform);
    const vf = buildVF(vertical, caption);

    await run('ffmpeg', [
      '-ss', String(startSec), '-i', rawFile,
      '-t', String(duration), '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', clipFile
    ], line => {
      const m = line.match(/time=(\d+:\d+:\d+)/);
      if (m) { const d = toSec(m[1]); job.progress = 62 + Math.round((d/duration)*33); job.message = 'Processing ' + Math.round((d/duration)*100) + '%'; }
    });

    try { fs.unlinkSync(rawFile); } catch(e) {}
    if (!fs.existsSync(clipFile)) throw new Error('ffmpeg failed');

    const size = (fs.statSync(clipFile).size/1024/1024).toFixed(1) + ' MB';
    job.status = 'done'; job.progress = 100; job.message = 'Done! (' + size + ')';
    job.file = path.basename(clipFile); job.filesize = size;
  } catch(e) {
    job.status = 'error'; job.error = e.message; job.message = 'Error: ' + e.message;
  }
}

function buildVF(vertical, caption) {
  const parts = [];
  if (vertical) parts.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1');
  else parts.push('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
  if (caption && caption.trim()) {
    const txt = caption.replace(/'/g,'').replace(/:/g,'\\:').replace(/,/g,'\\,').slice(0,100);
    parts.push("drawtext=text='"+txt+"':fontsize="+(vertical?48:36)+":fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y="+(vertical?'h-240':'h-100')+":box=1:boxcolor=black@0.3:boxborderw=10");
  }
  return parts.join(',');
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'] });
    p.stdout.on('data', d => onLine && onLine(d.toString()));
    p.stderr.on('data', d => onLine && onLine(d.toString()));
    p.on('close', code => code===0 ? resolve() : reject(new Error(cmd+' failed with code '+code)));
    p.on('error', e => reject(new Error(cmd+' not found: '+e.message)));
  });
}

function toSec(t) {
  if (!t) return 0;
  const p = String(t).split(':').map(Number);
  if (p.length===3) return p[0]*3600+p[1]*60+p[2];
  if (p.length===2) return p[0]*60+p[1];
  return Number(t)||0;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('⚡ ClipForge backend running on port', PORT));
