const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR);

const jobs = {};
let jc = 0;

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'clipforge.html');
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.json({ status: 'ClipForge Backend Running ⚡', version: '2.0' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, tools: { ytdlp: true, ffmpeg: true }, rapidapi: !!RAPIDAPI_KEY });
});

app.post('/clip', async (req, res) => {
  const { videoUrl, startTime, endTime, title, platform, caption } = req.body;
  if (!videoUrl || !startTime || !endTime)
    return res.status(400).json({ error: 'Missing videoUrl, startTime or endTime' });
  const jobId = 'j' + (++jc) + '_' + Date.now();
  jobs[jobId] = { status:'queued', progress:0, message:'Queued', file:null, error:null };
  res.json({ jobId });
  processClip(jobId, videoUrl, startTime, endTime, title||'clip', platform||'tiktok', caption||'');
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
    const safe = title.replace(/[^a-z0-9]/gi,'_').slice(0,35);
    const rawFile = path.join(os.tmpdir(), jobId+'_raw.mp4');
    const clipFile = path.join(CLIPS_DIR, safe+'_'+jobId.slice(1,6)+'.mp4');
    const startSec = toSec(startTime);
    const duration = toSec(endTime) - startSec;
    if (duration <= 0) throw new Error('Start must be before end');

    job.status='downloading'; job.progress=5; job.message='Getting video download link...';

    // Get direct download URL
    const directUrl = await getDirectVideoUrl(videoUrl, job);
    if (!directUrl) throw new Error('Could not get video download link — check your RapidAPI key in Railway Variables');

    // Download the video
    job.progress=15; job.message='Downloading video...';
    await downloadFile(directUrl, rawFile, (pct) => {
      job.progress = 15 + Math.round(pct * 0.45);
      job.message = 'Downloading ' + Math.round(pct) + '%';
    });

    if (!fs.existsSync(rawFile)) throw new Error('Download failed');

    // Cut + caption with ffmpeg
    job.status='processing'; job.progress=62; job.message='Cutting clip and adding captions...';
    const vertical = ['tiktok','instagram_reel','youtube_short'].includes(platform);
    const vf = buildVF(vertical, caption);

    await runFFmpeg([
      '-ss', String(startSec), '-i', rawFile,
      '-t', String(duration), '-vf', vf,
      '-c:v','libx264','-preset','fast','-crf','23',
      '-c:a','aac','-b:a','128k',
      '-movflags','+faststart','-y', clipFile
    ], (line) => {
      const m = line.match(/time=(\d+:\d+:\d+)/);
      if (m) { const d=toSec(m[1]); job.progress=62+Math.round((d/duration)*33); job.message='Cutting '+Math.round((d/duration)*100)+'%'; }
    });

    try { fs.unlinkSync(rawFile); } catch(e) {}
    if (!fs.existsSync(clipFile)) throw new Error('ffmpeg failed to create clip');

    const size = (fs.statSync(clipFile).size/1024/1024).toFixed(1)+' MB';
    job.status='done'; job.progress=100;
    job.message='Done! ('+size+')';
    job.file=path.basename(clipFile);
    job.filesize=size;

  } catch(e) {
    job.status='error'; job.error=e.message; job.message='Error: '+e.message;
    try { fs.unlinkSync(path.join(os.tmpdir(),jobId+'_raw.mp4')); } catch(err) {}
  }
}

async function getDirectVideoUrl(videoUrl, job) {
  // 1. Try RapidAPI YouTube downloader
  if (RAPIDAPI_KEY && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be'))) {
    try {
      job.message = 'Fetching via YouTube API...';
      const videoId = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
      if (!videoId) throw new Error('Invalid YouTube URL');

      const data = await rapidAPIRequest(
        'youtube-video-downloader1.p.rapidapi.com',
        '/dl?id=' + videoId,
        RAPIDAPI_KEY
      );

      // Find best quality MP4
      const formats = data.formats || data.links || [];
      const mp4 = formats.find(f => f.mimeType?.includes('video/mp4') && f.qualityLabel) ||
                  formats.find(f => f.ext === 'mp4' || f.format_id?.includes('mp4'));
      if (mp4) return mp4.url || mp4.link;

      // Try direct url field
      if (data.url) return data.url;
      if (data.link) return data.link;
    } catch(e) {
      job.message = 'YouTube API failed, trying direct...';
    }
  }

  // 2. Try yt-dlp with fallback options for Kick/Twitch
  try {
    job.message = 'Fetching stream URL...';
    return await getYtDlpUrl(videoUrl);
  } catch(e) {}

  // 3. Try cobalt.tools API (free, no key needed)
  try {
    job.message = 'Trying alternative downloader...';
    const cobalt = await fetch('https://api.cobalt.tools/api/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ url: videoUrl, vCodec: 'h264', vQuality: '720', isAudioMuted: false })
    });
    if (cobalt.ok) {
      const d = await cobalt.json();
      if (d.url) return d.url;
      if (d.status === 'stream' && d.url) return d.url;
    }
  } catch(e) {}

  return null;
}

function getYtDlpUrl(videoUrl) {
  return new Promise((resolve, reject) => {
    const args = ['-f','bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best','--get-url','--no-playlist',videoUrl];
    const p = spawn('yt-dlp', args, { stdio:['ignore','pipe','pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', code => {
      const url = out.trim().split('\n')[0];
      if (code===0 && url.startsWith('http')) resolve(url);
      else reject(new Error('yt-dlp could not get URL'));
    });
    p.on('error', reject);
  });
}

function rapidAPIRequest(host, path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host, path, method: 'GET',
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': host }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON from RapidAPI')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? require('https') : require('http');
    protocol.get(url, { headers:{ 'User-Agent':'Mozilla/5.0' } }, res => {
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total && onProgress) onProgress((downloaded/total)*100);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

function buildVF(vertical, caption) {
  const parts = [];
  if (vertical) parts.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1');
  else parts.push('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
  if (caption && caption.trim()) {
    const txt = caption.replace(/'/g,'').replace(/:/g,'\\:').replace(/,/g,'\\,').slice(0,100);
    const fs2 = vertical?48:36;
    const y = vertical?'h-240':'h-100';
    parts.push("drawtext=text='"+txt+"':fontsize="+fs2+":fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y="+y+":box=1:boxcolor=black@0.3:boxborderw=10");
  }
  return parts.join(',');
}

function runFFmpeg(args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio:['ignore','pipe','pipe'] });
    p.stdout.on('data', d => onLine && onLine(d.toString()));
    p.stderr.on('data', d => onLine && onLine(d.toString()));
    p.on('close', code => code===0?resolve():reject(new Error('ffmpeg failed with code '+code)));
    p.on('error', e => reject(new Error('ffmpeg: '+e.message)));
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
app.listen(PORT, () => console.log('⚡ ClipForge backend v2 running on port', PORT));
