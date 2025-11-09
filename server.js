import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { google } from 'googleapis';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { fetch as undiciFetch } from 'undici';
import cron from 'node-cron';

// -----------------------------------------------------------------------------
// Environment loader
// Read variables from a .env file if present. Each non-empty, non-comment
// line should follow KEY=VALUE syntax. This avoids adding dotenv dependency
// and makes local development easier without polluting the environment.
async function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  try {
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // ignore missing file
  }
}

await loadEnv();

// Configuration variables. Defaults come from the user specification. See README.
const {
  PEXELS_API_KEY,
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI,
  APP_BASE_URL = 'http://localhost:3000',
  DEFAULT_PRIVACY = 'public',
  AUTO_SCHEDULE_CRON = '0 14 * * *',
  AUTO_ENABLED = 'false',
  BG_MUSIC_URL = '',
  VOICEOVER_ENABLED = 'false'
} = process.env;

// Setup OAuth2 client for YouTube uploads
const oauth2Client = new google.auth.OAuth2(
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI
);

const TOKEN_PATH = path.join(process.cwd(), 'tmp', 'token.json');

async function loadSavedToken() {
  try {
    const json = await fs.readFile(TOKEN_PATH, 'utf8');
    oauth2Client.setCredentials(JSON.parse(json));
    return true;
  } catch {
    return false;
  }
}

async function saveToken(token) {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token), 'utf8');
}

await loadSavedToken();

// Express app
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(process.cwd(), 'public')));

// Global status log for UI
let statusLog = 'لم يتم تشغيل أي عملية بعد.';

// Settings persisted to disk
const SETTINGS_PATH = path.join(process.cwd(), 'tmp', 'settings.json');
let settings = {
  autoEnabled: AUTO_ENABLED.toLowerCase() === 'true',
  autoScheduleCron: AUTO_SCHEDULE_CRON
};

async function loadSettings() {
  try {
    const data = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
    if (typeof data.autoEnabled === 'boolean') settings.autoEnabled = data.autoEnabled;
    if (data.autoScheduleCron) settings.autoScheduleCron = data.autoScheduleCron;
  } catch {
    // no persisted settings
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings), 'utf8');
}

await loadSettings();

// Use static ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegStatic);

// Random topic pool
const RANDOM_TOPICS = [
  'civil rights moments',
  'jazz age streets',
  'route 66 nights',
  'gold rush tale',
  'brooklyn 1920s',
  'american vintage street',
  'dust bowl memories',
  'harlem renaissance vibes',
  'great depression life',
  'wild west legend'
];

const pickRandomTopic = () => RANDOM_TOPICS[Math.floor(Math.random() * RANDOM_TOPICS.length)];

// Caption generator with hashtags
function generateCaption(topic) {
  const base = `Echoes from ${topic}.`;
  const tags = ['#history', '#USA', '#vintage', '#shorts'];
  let result = base;
  for (const tag of tags) {
    if ((result + ' ' + tag).length <= 90) result += ' ' + tag;
  }
  return result;
}

// Escape text for drawtext filter
const ffEscape = s => s.replace(/'/g, "\\'").replace(/:/g, '\\:');

// SSE client registry and broadcasting helpers
const sseClients = new Set();

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastProgress(stepId, label, percent) {
  const payload = { type: 'progress', stepId, label, percent, ts: Date.now() };
  for (const client of sseClients) sendSSE(client, payload);
}

function broadcastDone(url) {
  const payload = { type: 'done', url, ts: Date.now() };
  for (const client of sseClients) sendSSE(client, payload);
}

function broadcastError(message) {
  const payload = { type: 'error', message, ts: Date.now() };
  for (const client of sseClients) sendSSE(client, payload);
}

// SSE endpoint
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Pexels search wrapper
async function pexelsSearch(query, perPage = 40) {
  const url = new URL('https://api.pexels.com/videos/search');
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('size', 'medium');
  url.searchParams.set('per_page', String(perPage));
  const res = await undiciFetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!res.ok) throw new Error(`Pexels API ${res.status}`);
  const data = await res.json();
  return data.videos || [];
}

// Download remote file; uses arrayBuffer because undici streams are WHATWG
async function downloadToFile(url, dest) {
  const response = await undiciFetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(dest, buf);
  return dest;
}

// Background music download cache
let bgMusicPath = null;
async function ensureBgMusic() {
  if (!BG_MUSIC_URL) return null;
  if (bgMusicPath && existsSync(bgMusicPath)) return bgMusicPath;
  const dest = path.join(process.cwd(), 'tmp', 'bg_music.mp3');
  try {
    await downloadToFile(BG_MUSIC_URL, dest);
    bgMusicPath = dest;
    return bgMusicPath;
  } catch (err) {
    console.error('BG music download failed:', err.message);
    return null;
  }
}

// Fetch at least 6 clips; loops through search queries to accumulate results
async function fetchClipsForTopic(topic) {
  broadcastProgress('clips', 'تجميع المقاطع', 5);
  const queries = [
    'historic reenactment',
    'american history',
    'vintage archive',
    'classic city street',
    'civil rights march',
    'retro footage',
    'old film',
    topic
  ];
  const chosen = [];
  for (const q of queries) {
    try {
      const results = await pexelsSearch(q);
      for (const video of results) {
        const { width, height, video_files: files, duration } = video;
        // keep only portrait orientation
        if (height < width) continue;
        let file = files.find(vf => vf.quality === 'hd' && vf.width >= 720) ||
                   files.find(vf => vf.width >= 480) || files[0];
        if (!file) continue;
        chosen.push({ url: file.link, duration });
        if (chosen.length >= 8) break;
      }
    } catch (err) {
      console.error('Pexels search error:', err.message);
    }
    if (chosen.length >= 8) break;
  }
  if (chosen.length < 6) throw new Error('لا توجد مقاطع كافية من Pexels');
  const clipPaths = [];
  let i = 0;
  for (const item of chosen) {
    const dest = path.join(process.cwd(), 'tmp', `clip_${Date.now()}_${i++}.mp4`);
    await downloadToFile(item.url, dest);
    clipPaths.push({ path: dest, duration: item.duration });
    const pct = Math.min(30, 5 + Math.round((clipPaths.length / chosen.length) * 25));
    broadcastProgress('clips', 'تجميع المقاطع', pct);
  }
  return clipPaths;
}

// Build a 15-second vertical video using FFmpeg. Applies crossfades, scaling,
// cropping, overlay text and optional music. Progress is reported via SSE.
async function createVideo(clips, title) {
  const xfadeDur = 0.35;
  const totalDur = 15.0;
  const count = Math.min(clips.length, 6);
  const used = clips.slice(0, count);
  const segDur = Number(((totalDur + xfadeDur * (count - 1)) / count).toFixed(3));
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(i === 0 ? 0 : Number((offsets[i - 1] + segDur - xfadeDur).toFixed(3)));
  }
  const filters = [];
  const escTitle = ffEscape(title);
  for (let i = 0; i < count; i++) {
    filters.push(
      `[${i}:v]trim=0:${segDur},setpts=PTS-STARTPTS,scale=1080:-2,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[v${i}]`
    );
  }
  let current = '[v0]';
  for (let i = 1; i < count; i++) {
    const out = i === count - 1 ? '[vtmp]' : `[vxf${i}]`;
    filters.push(
      `${current}[v${i}]xfade=transition=fade:duration=${xfadeDur}:offset=${offsets[i]}${out}`
    );
    current = out;
  }
  filters.push(
    `${current}drawtext=text='${escTitle}':fontcolor=Lavender:fontsize=80:` +
    `font=DejaVuSans-Bold:box=1:boxcolor=black@0.4:boxborderw=10:` +
    `x=(w-text_w)/2:y=h*0.28+sin(2*PI*t/3)*20:` +
    `shadowcolor=black:shadowx=5:shadowy=5:enable='between(t,0.3,3)'[vtxt1]`
  );
  filters.push(
    `[vtxt1]drawtext=text='American Short Story':fontcolor=Lavender:fontsize=40:` +
    `font=DejaVuSans-Bold:box=1:boxcolor=black@0.4:boxborderw=8:` +
    `x=(w-text_w)/2:y=h*0.28+100:enable='between(t,0.6,2.8)'[vfinal]`
  );
  const cmd = ffmpeg();
  for (const clip of used) {
    cmd.input(clip.path);
    cmd.inputOptions('-an');
  }
  const music = await ensureBgMusic();
  if (music) cmd.input(music);
  cmd.complexFilter(filters, 'vfinal');
  if (music) {
    cmd.outputOptions([
      '-map', '[vfinal]',
      '-map', `${used.length}:a`,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-filter:a', 'volume=0.15',
      '-shortest'
    ]);
  } else {
    cmd.outputOptions(['-map', '[vfinal]']);
    cmd.outputOptions('-an');
  }
  cmd.outputOptions([
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-crf', '23',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-t', `${totalDur}`,
    '-movflags', '+faststart'
  ]);
  const outPath = path.join(process.cwd(), 'tmp', `out_${Date.now()}.mp4`);
  await new Promise((resolve, reject) => {
    let lastPct = 35;
    cmd.on('progress', p => {
      if (p.percent) {
        const pct = Math.max(35, Math.min(75, 35 + Math.round(p.percent * 0.4)));
        if (pct !== lastPct) {
          lastPct = pct;
          broadcastProgress('compose', 'إنشاء الفيديو', pct);
        }
      }
    });
    cmd.on('error', reject);
    cmd.on('end', resolve);
    cmd.save(outPath);
  });
  broadcastProgress('prepare', 'تجهيز الفيديو', 82);
  return outPath;
}

// Upload video via YouTube Data API. Updates progress near completion.
async function uploadToYouTube(filePath, title, caption, privacy) {
  broadcastProgress('upload', 'رفع الفيديو', 85);
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const tags = ['shorts', 'history', 'USA', 'vintage', 'story'];
  const requestBody = {
    snippet: {
      title: title.slice(0, 60),
      description: caption + '\nGenerated 9:16 automatically.',
      tags
    },
    status: { privacyStatus: privacy || DEFAULT_PRIVACY }
  };
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody,
    media: { body: createReadStream(filePath) }
  });
  broadcastProgress('upload', 'رفع الفيديو', 98);
  return res.data.id;
}

// Full pipeline: select topic, fetch clips, create video, caption, upload, cleanup
async function generateAndUpload({ topic, privacy }) {
  const finalTopic = topic && topic.trim() ? topic.trim() : pickRandomTopic();
  const title = `Short American Story — ${finalTopic}`;
  const clips = await fetchClipsForTopic(finalTopic);
  broadcastProgress('caption', 'كتابة الكابتشن', 32);
  const caption = generateCaption(finalTopic);
  const videoPath = await createVideo(clips, finalTopic);
  const id = await uploadToYouTube(videoPath, title, caption, privacy);
  const url = `https://youtu.be/${id}`;
  try {
    await fs.unlink(videoPath);
    for (const c of clips) await fs.unlink(c.path);
  } catch {}
  broadcastProgress('upload', 'رفع الفيديو', 100);
  broadcastDone(url);
  return { message: 'تم الرفع بنجاح', url };
}

// Cron scheduling
let cronJob = null;

function scheduleAutoJob() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  if (!settings.autoEnabled) return;
  cronJob = cron.schedule(settings.autoScheduleCron, async () => {
    try {
      if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
        statusLog = 'يرجى ربط يوتيوب أولًا.';
        broadcastError(statusLog);
        return;
      }
      const result = await generateAndUpload({ topic: '', privacy: DEFAULT_PRIVACY });
      statusLog = `${new Date().toLocaleString('ar-IQ')} : ${result.message} - ${result.url}`;
    } catch (err) {
      statusLog = `${new Date().toLocaleString('ar-IQ')} : فشل العملية: ${err.message}`;
      broadcastError(err.message);
    }
  }, { timezone: 'Asia/Baghdad' });
}

// Initialise cron job on server start
scheduleAutoJob();

// Root route: serve HTML with placeholders
app.get('/', async (req, res) => {
  const filePath = path.join(process.cwd(), 'views', 'index.html');
  let html = await fs.readFile(filePath, 'utf8');
  html = html.replace(/__AUTO_SCHEDULE__/g, settings.autoScheduleCron);
  html = html.replace(/__AUTO_ENABLED_SELECTED_TRUE__/g, settings.autoEnabled ? 'selected' : '');
  html = html.replace(/__AUTO_ENABLED_SELECTED_FALSE__/g, settings.autoEnabled ? '' : 'selected');
  html = html.replace(/__STATUS__/g, statusLog);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// OAuth: redirect to Google consent screen
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes });
  res.redirect(url);
});

// OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveToken(tokens);
    statusLog = 'تم الربط بحساب يوتيوب بنجاح.';
    res.redirect('/');
  } catch (err) {
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// Save settings from auto form
app.post('/settings', async (req, res) => {
  const { autoScheduleCron, autoEnabled } = req.body;
  if (autoScheduleCron) settings.autoScheduleCron = autoScheduleCron.trim();
  settings.autoEnabled = autoEnabled === 'true';
  await saveSettings();
  scheduleAutoJob();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('تم حفظ الإعدادات بنجاح');
});

// Generate random topic for manual form (htmx-like replacement). Returns an input element with value
app.get('/generate-topic', (req, res) => {
  const t = pickRandomTopic();
  const html = `<input type="text" name="topic" id="video-topic" placeholder="wild west legend" class="flex-grow p-3 rounded-xl bg-gray-700 border border-gray-600 focus:ring-indigo-500 focus:border-indigo-500" value="${t}" />`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Manual generation route. Launches background job and returns immediately.
app.post('/generate', async (req, res) => {
  if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
    const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes });
    return res.send(`يرجى ربط يوتيوب أولًا: <a href="${url}" class="text-blue-600 underline">ربط الحساب</a>`);
  }
  const topic = (req.body.topic || '').trim();
  const privacy = (req.body.privacy || DEFAULT_PRIVACY).trim();
  // Start the async pipeline without blocking the response
  (async () => {
    try {
      await generateAndUpload({ topic, privacy });
      statusLog = `${new Date().toLocaleString('ar-IQ')} : تم الرفع بنجاح`;
    } catch (err) {
      statusLog = `${new Date().toLocaleString('ar-IQ')} : فشل العملية: ${err.message}`;
      broadcastError(err.message);
    }
  })();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('بدأت العملية... تابع شريط التقدم بالأعلى.');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});