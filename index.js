require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

// ---------------------------------------------------------------------------
// Startup validation — fail fast instead of crashing mid-request on Render
// ---------------------------------------------------------------------------
console.log('[BOOT] Starting Student Mark Extraction API...');

if (!process.env.GROQ_API_KEY) {
  console.error('[BOOT][FATAL] GROQ_API_KEY is not set. Add it in Render → Environment.');
  process.exit(1);
}
console.log('[BOOT] GROQ_API_KEY detected, length:', process.env.GROQ_API_KEY.length);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  timeout: 30_000, // don't let a stuck Groq call hang the request forever
  maxRetries: 2,   // SDK-level retry with backoff on 429/5xx/network errors
});
console.log('[BOOT] Groq client initialized (timeout=30000ms, maxRetries=2)');

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
app.use(helmet());
console.log('[BOOT] helmet security middleware attached');

app.use(cors()); // tighten with { origin: 'chrome-extension://<id>' } once you know it
console.log('[BOOT] cors middleware attached (open origin)');

app.use(express.json({ limit: '1mb' }));
console.log('[BOOT] express.json middleware attached (limit=1mb)');

// Basic abuse protection — Render free/starter tiers die fast under load
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 requests/minute/IP — adjust to your real usage
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, slow down.' },
  handler: (req, res, next, options) => {
    console.warn(`[RATE-LIMIT] IP ${req.ip} exceeded 30 req/min on ${req.originalUrl}`);
    res.status(options.statusCode).json(options.message);
  },
});
app.use('/transcribe', limiter);
console.log('[BOOT] rate limiter attached to /transcribe (30 req/min/IP)');

// ---------------------------------------------------------------------------
// Multer: memory storage, not disk
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB — Groq Whisper's hard limit
  },
  fileFilter: (_req, file, cb) => {
    const allowed = /^audio\//.test(file.mimetype) || /^video\/webm$/.test(file.mimetype);
    console.log(`[MULTER] Incoming file "${file.originalname}" mimetype="${file.mimetype}" allowed=${allowed}`);
    if (!allowed) {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  },
});
console.log('[BOOT] multer configured (memoryStorage, 25MB limit, audio/* + video/webm only)');

const AUDIO_PROMPT = `
You are a precise data extraction assistant specialized in parsing mixed Bengali/English student mark records.
Your ONLY task is to extract student IDs and marks from the input text and return a STRICTLY VALID JSON array.
Do not output any explanations, markdown, code blocks, or extra text.

OUTPUT FORMAT (exact):
[{"student id": "XXX-XX-XXX", "mark": 15}]
DIGIT MERGING
Raw input may contain digits separated by spaces (e.g., "2 6 2 1 5 5 5 0").
FIRST, merge consecutive space-separated digits into a single number.
NEVER treat spaced digits as separate values.
DYNAMIC ID FORMATTING

Case A : 8-digit numbers → split as first 3 - next 2 - last 3 → "XXX-XX-XXX"
Example: 26215550 → "262-15-550"

Case B : 1-3 digit numbers (short suffix) → left-pad with zeros to 3 digits
Example: 6 → 006, 241 → 241

PREFIX INHERITANCE: Use the "XXX-XX-" prefix from the last full 8-digit ID seen.
If no full ID seen yet, default prefix is "000-00-".
Example: After "262-15-550", a short ID "241" becomes "262-15-241"

Exception: If text says "section 25", use "232-25-" for short suffixes 001-099.

Case D : 16-digit numbers → output exactly as spoken/scanned, no reformatting, no splitting.
Example: 0242220005101707 → "student id": "0242220005101707"
These are barcode/card IDs. Never split or reformat them.

NEW  Case C (comma separated ID parts)
When the input contains numbers separated by commas before a mark keyword (e.g., 251, 15012 got 7), interpret as:

Format 1: PPP, MMMSS where PPP = 3 digits, MMMSS = 5 digits → extract middle 2 digits (positions 1‑2 of the 5‑digit number) and last 3 digits.
Example: 251, 15012 → prefix = 251, middle = first two digits of 15012 = 15, suffix = last three digits = 012 → "251-15-012"

Format 2: PPP, MM, SSS where PPP = 3 digits, MM = 2 digits, SSS = 1‑3 digits → pad SSS to 3 digits.
Example: 251, 15, 125 → "251-15-125"

Prefix/middle inheritance after Case C: Once a full ID like "251-15-012" is built, any later standalone 1‑3 digit suffix (e.g., 138 before got) inherits "251-15-" → "251-15-138".

SEQUENTIAL MARK EXTRACTION

Keywords that mean a mark follows: "got", "গাট", "marks", "নম্বর" , "peyece" , "পেয়েছে"

Parse left-to-right in blocks: [ID] [keyword] [mark number]

Marks are integers 0-100. Never confuse ID digits with marks.

OUTPUT RULES

One JSON object per valid ID + mark pair

Only two keys allowed: "student id" and "mark"

"mark" must be a number (not a string)

Empty or unparseable input → return exactly: []

Output ONLY raw JSON starting with [ and ending with ]. No markdown, no backticks.

EXAMPLES :

Input: 23215380 গাট 13 820 গাট 15 895 গাট 9
Output: [{"student id":"232-15-380","mark":13},{"student id":"232-15-820","mark":15},{"student id":"232-15-895","mark":9}]

Input: 105 গাট 70 208 got 92 midterm
Output: [{"student id":"232-15-105","mark":70},{"student id":"232-15-208","mark":92}]

Input: 2 6 2 1 5 5 5 0 got 14 2 4 1 got 15
Output: [{"student id":"262-15-550","mark":14},{"student id":"262-15-241","mark":15}]

NEW EXAMPLES (comma separated IDs):

Input: 251, 15012 got 7, 251, 15, 125 got 8, 138 got 10, 146 got 20, 138 got 5
Output: [{"student id":"251-15-012","mark":7},{"student id":"251-15-125","mark":8},{"student id":"251-15-138","mark":10},{"student id":"251-15-146","mark":20},{"student id":"251-15-138","mark":5}]

Input: 300, 22045 got 6, 47 got 92 , 300, 22,048 got 5,
Output: [{"student id":"300-22-045","mark":6},{"student id":"300-22-047","mark":92},{"student id":"300-22-048","mark":5}]
`;

// ---------------------------------------------------------------------------
// DATASET_AUDIO_PROMPT — used when a student dataset is provided
// Outputs {"key": "...", "mark": N} instead of {"student id": "...", "mark": N}
// so the server can fuzzy-match the key against the known student list.
// ---------------------------------------------------------------------------
const DATASET_AUDIO_PROMPT = `
You are a precise data extraction assistant. Your ONLY task is to extract each person's name or ID and their mark from the input text. Return a STRICTLY VALID JSON array.

OUTPUT FORMAT (exact):
[{"key": "Habibul", "mark": 19}]

RULES:
- "key" is the name or partial ID as spoken (e.g. "Habibul", "2336", "1707")
- "mark" is an integer 0-100
- One object per valid key + mark pair
- Empty or unparseable input → return exactly: []
- Output ONLY raw JSON starting with [ and ending with ]. No markdown, no backticks.

EXAMPLES:
Input: "Habibul got 19, 2336 got 17, 1707 got 20"
Output: [{"key":"Habibul","mark":19},{"key":"2336","mark":17},{"key":"1707","mark":20}]

Input: "give 19 to Habibul, Tushar scored 20"
Output: [{"key":"Habibul","mark":19},{"key":"Tushar","mark":20}]

Input: "Zerin 20, Habibul 19"
Output: [{"key":"Zerin","mark":20},{"key":"Habibul","mark":19}]
Input: 23215380 গাট 13 820 গাট 15 895 গাট 9
Output: [{"student id":"232-15-380","mark":13},{"student id":"232-15-820","mark":15},{"student id":"232-15-895","mark":9}]

Input: 105 গাট 70 208 got 92 midterm
Output: [{"student id":"232-15-105","mark":70},{"student id":"232-15-208","mark":92}]

Input: 2 6 2 1 5 5 5 0 got 14 2 4 1 got 15
Output: [{"student id":"262-15-550","mark":14},{"student id":"262-15-241","mark":15}]

NEW EXAMPLES (comma separated IDs):

Input: 251, 15012 got 7, 251, 15, 125 got 8, 138 got 10, 146 got 20, 138 got 5
Output: [{"student id":"251-15-012","mark":7},{"student id":"251-15-125","mark":8},{"student id":"251-15-138","mark":10},{"student id":"251-15-146","mark":20},{"student id":"251-15-138","mark":5}]

Input: 300, 22045 got 6, 47 got 92 , 300, 22,048 got 5,
Output: [{"student id":"300-22-045","mark":6},{"student id":"300-22-047","mark":92},{"student id":"300-22-048","mark":5}]

`.trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Groq (and LLMs in general) sometimes wrap JSON in ```json fences or add
// stray text despite instructions. Strip fences first, then fall back to
// pulling out the first [...] block so a slightly noisy response doesn't
// turn into a hard failure.
function safeParseJsonArray(raw) {
  console.log('[PARSE] Raw model output (first 500 chars):', (raw || '').slice(0, 500));

  if (!raw) {
    console.warn('[PARSE] Raw output is empty/null — returning []');
    return [];
  }
  let text = raw.trim().replace(/^```json\s*|^```\s*|```$/gim, '').trim();

  try {
    const parsed = JSON.parse(text);
    const result = Array.isArray(parsed) ? parsed : [];
    console.log(`[PARSE] Direct JSON.parse succeeded — ${result.length} record(s) extracted`);
    return result;
  } catch (directErr) {
    console.warn('[PARSE] Direct JSON.parse failed:', directErr.message, '— attempting regex fallback');
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const result = Array.isArray(parsed) ? parsed : [];
        console.log(`[PARSE] Regex fallback JSON.parse succeeded — ${result.length} record(s) extracted`);
        return result;
      } catch (fallbackErr) {
        console.error('[PARSE] Regex fallback JSON.parse also failed:', fallbackErr.message);
        return [];
      }
    }
    console.error('[PARSE] No [...] block found in model output — returning []');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dataset matching helpers — ported from the Kaggle Flask API
// Used when a student dataset is provided to fuzzy-match LLM output
// against known student IDs.
// ---------------------------------------------------------------------------

function normalize(s) {
  return String(s).replace(/[-\s]/g, '').toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const normA = normalize(a);
  const normB = normalize(b);
  if (normA === normB) return 1.0;
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(normA, normB) / maxLen;
}

function matchToDataset(rawKey, dataset, threshold = 0.7) {
  const rawNorm = normalize(rawKey);
  let bestMatch = null;
  let bestScore = 0;

  for (const entry of dataset) {
    const entryIdNorm = normalize(entry.id);
    const entryNameNorm = normalize(entry.name);

    // Priority 1: Exact name match
    if (entryNameNorm === rawNorm) {
      return { id: entry.id, score: 1.0 };
    }
    // Priority 2: Exact full ID match
    if (entryIdNorm === rawNorm) {
      return { id: entry.id, score: 1.0 };
    }
    // Priority 3: Last 4 digits of ID
    if (rawNorm.length === 4 && entryIdNorm.endsWith(rawNorm)) {
      return { id: entry.id, score: 0.98 };
    }
    // Priority 4: Last 3 digits of ID
    if (rawNorm.length === 3 && entryIdNorm.endsWith(rawNorm)) {
      return { id: entry.id, score: 0.97 };
    }
    // Priority 5: Partial ID contains match (>=5 chars)
    if (rawNorm.length >= 5) {
      if (entryIdNorm.includes(rawNorm) || rawNorm.includes(entryIdNorm)) {
        return { id: entry.id, score: 0.95 };
      }
    }
    // Priority 6: Fuzzy name match
    const nameScore = similarity(rawKey, entry.name);
    if (nameScore > bestScore) {
      bestScore = nameScore;
      bestMatch = entry.id;
    }
  }

  if (bestScore >= threshold) {
    return { id: bestMatch, score: bestScore };
  }
  return null;
}

// In-memory File-like wrapper so groq-sdk can stream a Buffer without ever
// touching disk.
function bufferToUploadable(buffer, filename) {
  console.log(`[UPLOADABLE] Wrapping buffer as in-memory file "${filename}" (${buffer.length} bytes)`);
  return new File([buffer], filename, { type: 'application/octet-stream' });
}

async function transcribeAudio(buffer, filename) {
  console.log(`[GROQ][WHISPER] Sending audio to whisper-large-v3-turbo — file="${filename}", size=${buffer.length} bytes`);
  const start = Date.now();
  try {
    const result = await groq.audio.transcriptions.create({
      file: bufferToUploadable(buffer, filename),
      model: 'whisper-large-v3-turbo',
      temperature: 0,
      response_format: 'json', // lighter than verbose_json — we only need .text
    });
    console.log(`[GROQ][WHISPER] Transcription completed in ${Date.now() - start}ms`);
    console.log('[GROQ][WHISPER] Transcribed text:', result.text);
    return result;
  } catch (err) {
    console.error(`[GROQ][WHISPER] Transcription FAILED after ${Date.now() - start}ms:`, err?.status || '', err?.message || err);
    throw err;
  }
}

async function extractMarks(transcribedText) {
  console.log('[GROQ][LLAMA] Sending transcribed text to llama-3.1-8b-instant for mark extraction');
  console.log('[GROQ][LLAMA] Input text:', transcribedText);
  const start = Date.now();
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: `${AUDIO_PROMPT}\n\nInput: ${transcribedText}` }],
      model: 'llama-3.1-8b-instant',
      temperature: 0, // deterministic extraction, not creative writing — also fewer retries needed
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
    });
    console.log(`[GROQ][LLAMA] Completion received in ${Date.now() - start}ms`);
    const content = completion.choices[0]?.message?.content || '[]';
    console.log('[GROQ][LLAMA] Raw completion content:', content);
    if (completion.usage) {
      console.log('[GROQ][LLAMA] Token usage:', completion.usage);
    }
    return content;
  } catch (err) {
    console.error(`[GROQ][LLAMA] Extraction FAILED after ${Date.now() - start}ms:`, err?.status || '', err?.message || err);
    throw err;
  }
}

async function extractMarksWithDataset(transcribedText) {
  console.log('[GROQ][LLAMA] Sending transcribed text to llama-3.1-8b-instant for dataset-aware extraction');
  console.log('[GROQ][LLAMA] Input text:', transcribedText);
  const start = Date.now();
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: `${DATASET_AUDIO_PROMPT}\n\nInput: ${transcribedText}` }],
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
    });
    console.log(`[GROQ][LLAMA] Dataset-aware completion received in ${Date.now() - start}ms`);
    const content = completion.choices[0]?.message?.content || '[]';
    console.log('[GROQ][LLAMA] Raw completion content:', content);
    if (completion.usage) {
      console.log('[GROQ][LLAMA] Token usage:', completion.usage);
    }
    return content;
  } catch (err) {
    console.error(`[GROQ][LLAMA] Dataset-aware extraction FAILED after ${Date.now() - start}ms:`, err?.status || '', err?.message || err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const reqStart = Date.now();
  console.log(`\n[REQUEST] POST /transcribe received from IP=${req.ip} at ${new Date().toISOString()}`);

  if (!req.file) {
    console.warn('[REQUEST] No file present on req.file — rejecting with 400');
    return res.status(400).json({ success: false, error: 'No audio file provided (field name must be "audio").' });
  }

  console.log(`[REQUEST] File received: name="${req.file.originalname}", mimetype="${req.file.mimetype}", size=${req.file.size} bytes`);

  // Optional student dataset — JSON string in form field "dataset"
  let dataset = null;
  if (req.body.dataset) {
    try {
      dataset = JSON.parse(req.body.dataset);
      console.log(`[REQUEST] Dataset provided: ${dataset.length} student(s) in list`);
    } catch (e) {
      console.warn('[REQUEST] Invalid JSON in "dataset" field — ignoring', e.message);
    }
  }

  try {
    console.log('[STEP 1/2] Starting transcription...');
    const transcription = await transcribeAudio(req.file.buffer, req.file.originalname || 'audio.webm');
    const transcribedText = transcription.text || '';

    if (!transcribedText.trim()) {
      console.warn('[STEP 1/2] Transcription returned empty text');
      return res.json([]);
    }
    console.log('[STEP 1/2] Transcription complete.');

    // ── DATASET MODE ──
    if (dataset && Array.isArray(dataset) && dataset.length > 0) {
      console.log('[STEP 2/2] Starting dataset-aware extraction...');
      const rawContent = await extractMarksWithDataset(transcribedText);
      const parsed = safeParseJsonArray(rawContent);
      console.log(`[STEP 2/2] LLM extracted ${parsed.length} key(s):`, JSON.stringify(parsed));

      const result = [];
      const unmatched = [];
      for (const item of parsed) {
        const matched = matchToDataset(item.key, dataset);
        if (matched) {
          result.push({ id: matched.id, mark: item.mark });
          console.log(`  ✓ "${item.key}" → ${matched.id} (score: ${matched.score})`);
        } else {
          unmatched.push(item.key);
          console.log(`  ✗ "${item.key}" → no match in dataset`);
        }
      }

      const formatted = result.map(r => ({ 'student id': r.id, mark: r.mark }));
      console.log(`[STEP 2/2] Dataset matching complete: ${result.length} matched, ${unmatched.length} unmatched`);
      console.log(`[REQUEST] Total request time: ${Date.now() - reqStart}ms — responding 200 OK\n`);
      return res.json(formatted);
    }

    // ── ORIGINAL MODE (no dataset) — unchanged behavior ──
    console.log('[STEP 2/2] Starting mark extraction...');
    const rawContent = await extractMarks(transcribedText);
    const parsed = safeParseJsonArray(rawContent);
    console.log(`[STEP 2/2] Extraction complete. ${parsed.length} record(s) parsed:`, JSON.stringify(parsed));

    console.log(`[REQUEST] Total request time: ${Date.now() - reqStart}ms — responding 200 OK\n`);
    return res.json( parsed );
  } catch (err) {
    console.error(`[REQUEST] Error after ${Date.now() - reqStart}ms — routing to error handler\n`);
    return handleGroqError(err, res);
  }
  // No finally/unlink needed — memoryStorage never wrote to disk.
});

function handleGroqError(err, res) {
  console.error('[ERROR] transcribe error:', err?.message || err);
  if (err?.stack) {
    console.error('[ERROR] Stack trace:', err.stack);
  }

  // groq-sdk (OpenAI-style) errors carry a `status` for HTTP failures
  const status = err?.status;
  console.error(`[ERROR] Upstream status code: ${status || 'N/A'}`);

  if (status === 429) {
    console.warn('[ERROR] 429 Rate limited by Groq — responding 429 to client');
    return res.status(429).json({ success: false, error: 'Rate limited by Groq. Try again shortly.' });
  }
  if (status === 401 || status === 403) {
    console.error('[ERROR] 401/403 Auth failure with Groq — check GROQ_API_KEY — responding 500 to client');
    return res.status(500).json({ success: false, error: 'Server auth misconfiguration.' });
  }
  if (err?.name === 'AbortError' || err?.code === 'ETIMEDOUT') {
    console.error('[ERROR] Timeout/AbortError talking to Groq — responding 504 to client');
    return res.status(504).json({ success: false, error: 'Upstream transcription timed out.' });
  }
  console.error('[ERROR] Unclassified error — responding 502 to client');
  return res.status(502).json({ success: false, error: 'Transcription/parsing failed. Please retry.' });
}

app.get('/health', (_req, res) => {
  const now = new Date();
  const uptimeSeconds = process.uptime();
  const mem = process.memoryUsage();

  const healthInfo = {
    status: 'ok',
    service: 'Student Mark Extraction API',
    currentTime: {
      iso: now.toISOString(),
      utc: now.toUTCString(),
      unix: Math.floor(now.getTime() / 1000),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    uptime: {
      seconds: Number(uptimeSeconds.toFixed(2)),
      formatted: formatUptime(uptimeSeconds),
    },
    models: {
      transcription: {
        provider: 'Groq',
        model: 'whisper-large-v3-turbo',
        purpose: 'Audio → text transcription',
      },
      extraction: {
        provider: 'Groq',
        model: 'llama-3.1-8b-instant',
        purpose: 'Text → structured JSON (student id + mark)',
      },
    },
    config: {
      port,
      maxFileSizeMB: 25,
      allowedFileTypes: ['audio/*', 'video/webm'],
      rateLimit: '30 requests/minute/IP on /transcribe',
      requestTimeoutMs: server.requestTimeout,
      headersTimeoutMs: server.headersTimeout,
      groqTimeoutMs: 30_000,
      groqMaxRetries: 2,
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      memoryUsageMB: {
        rss: Number((mem.rss / 1024 / 1024).toFixed(2)),
        heapTotal: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
        heapUsed: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        external: Number((mem.external / 1024 / 1024).toFixed(2)),
      },
    },
    env: {
      groqApiKeyConfigured: Boolean(process.env.GROQ_API_KEY),
      nodeEnv: process.env.NODE_ENV || 'not set',
    },
  };

  console.log(`[HEALTH] /health check hit — uptime=${uptimeSeconds.toFixed(1)}s, mem(heapUsed)=${healthInfo.system.memoryUsageMB.heapUsed}MB`);
  res.json(healthInfo);
});

// Helper: turn raw seconds into a human-readable "Xd Xh Xm Xs" string
function formatUptime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Error middleware — must be last. Catches multer errors (size/type) so they
// return clean JSON instead of an unhandled exception / raw HTML error page.
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[MIDDLEWARE-ERROR] Caught by final error handler:', err?.message || err);
  if (err instanceof multer.MulterError) {
    console.error('[MIDDLEWARE-ERROR] MulterError code:', err.code);
    if (err.code === 'LIMIT_FILE_SIZE') {
      console.warn('[MIDDLEWARE-ERROR] File exceeded 25MB limit — responding 413');
      return res.status(413).json({ success: false, error: 'Audio file too large (max 25MB).' });
    }
    return res.status(400).json({ success: false, error: `Upload error: ${err.code}` });
  }
  if (err?.message === 'UNSUPPORTED_FILE_TYPE') {
    console.warn('[MIDDLEWARE-ERROR] Unsupported file type uploaded — responding 415');
    return res.status(415).json({ success: false, error: 'Unsupported file type — audio only.' });
  }
  console.error('[MIDDLEWARE-ERROR] Unhandled error, stack:', err?.stack || err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.use((req, res) => {
  console.warn(`[404] No route matched: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, error: 'Not found.' });
});

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
const server = app.listen(port, () => {
  console.log(`[BOOT] Server running on http://localhost:${port}`);
  console.log('[BOOT] Ready to accept requests at POST /transcribe (field: "audio") and GET /health\n');
});

// Groq calls can legitimately take a while for longer audio — keep the
// socket open longer than Express's stingy 5s default headers timeout.
server.requestTimeout = 120_000;
server.headersTimeout = 125_000;

// Render sends SIGTERM on redeploy/scale-down — exit cleanly instead of
// dropping in-flight requests abruptly.
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received, shutting down gracefully.');
  server.close(() => {
    console.log('[SHUTDOWN] All connections closed. Exiting process.');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[SHUTDOWN] Forced exit after 10s grace period.');
    process.exit(1);
  }, 10_000).unref();
});

// Extra safety nets so silent crashes always show up in the terminal
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
