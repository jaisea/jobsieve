import { httpJson } from '../util.js';
import * as keystate from '../keystate.js';
import { nextQuotaReset } from '../awaiting.js';

/**
 * Google Gemini via the Generative Language API.
 * Free tier is generous enough for this workload; get a key at
 * https://aistudio.google.com/apikey
 */
export const id = 'gemini';
export const label = 'Gemini';

// Read when asked, not at load: index.js imports this before .env exists. The override is for
// tests, which point the real command at a local fake server instead of Google.
const base = () => process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
// `-lite` matters: the newest flash models cap the free tier at ~20 requests
// PER DAY, while the lite line allows enough to adjudicate a real run. The
// `-latest` alias tracks the current lite model so this cannot go stale.
const DEFAULT_MODEL = 'gemini-flash-lite-latest';

// Judging and writing are configured apart: GEMINI_<THING>_JUDGE and
// GEMINI_<THING>_APPLY. There are no unsuffixed names.
const judgeEnv = (name) => process.env[`${name}_JUDGE`];

export const configured = () => Boolean(judgeEnv('GEMINI_API_KEY'));

/**
 * Writing a CV can use a different key from judging. The two have opposite
 * needs: judging is high volume and belongs on a free-tier project, writing is
 * two or three calls and can sit on a paid one for the better model. Billing
 * attaches to the PROJECT a key was made in, so the only way to put one on the
 * free tier and the other on the paid one is two keys. Unset means "use the
 * judging key", so nothing changes until this is set.
 */
const keyFor = (purpose) => (purpose === 'apply' && process.env.GEMINI_API_KEY_APPLY) || judgeEnv('GEMINI_API_KEY');

/**
 * Report the model actually in use, and say so when it is not the one asked
 * for. Silently substituting a working model made a malformed GEMINI_MODEL
 * look like a successful run: `npm run keys` printed "working — model
 * gemini-flash-lite-latest" whatever you had configured, so the setting
 * appeared to be ignored with no way to see why.
 */
export const describe = () => {
  const asked = judgeEnv('GEMINI_MODEL');
  if (fellBackFrom) return `model ${resolvedModel} — "${fellBackFrom}" does not exist for this key`;
  const overflow = overflowOn() ? ' · when the free daily quota is spent it continues on the billed key' : '';
  return `model ${resolvedModel || asked || DEFAULT_MODEL}${overflow}`;
};

/** Set once per run if the configured model turns out not to exist. */
let resolvedModel = null;
/** The name that 404'd, kept so the substitution can be reported rather than hidden. */
let fellBackFrom = null;

/**
 * Gemini accepts a subset of JSON Schema. `additionalProperties` in particular
 * is rejected, so the shared schema is translated rather than passed through.
 */
function toGeminiSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(toGeminiSchema);

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties') continue;
    if (k === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)])
      );
    } else if (k === 'items') {
      out.items = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Ask the API which models this key can actually use — beats guessing. */
export async function listModels() {
  const r = await httpJson(`${base()}/models`, {
    headers: { 'x-goog-api-key': judgeEnv('GEMINI_API_KEY') },
  });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  const usable = (r.data?.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  return { ok: true, models: usable };
}

/**
 * Pick a working model when the configured one 404s. Prefers a `flash` variant
 * — this is a short classification task, so the cheap fast tier is right.
 */
async function pickFallbackModel() {
  const r = await listModels();
  if (!r.ok || !r.models.length) return null;
  const usable = (m) => !/thinking|image|tts|embed|audio|native|video|omni|exp|preview/.test(m);
  // Lite first — it is the only tier with a free daily quota big enough to be
  // useful here. Picking the newest flash gets you 20 requests a day.
  return r.models.find((m) => /flash-lite/.test(m) && usable(m))
    || r.models.find((m) => /flash/.test(m) && usable(m))
    || r.models.find(usable)
    || r.models[0];
}

/**
 * `model` lets one caller ask for a different model from the rest of the run.
 *
 * Judging job adverts is high volume — about twenty calls a run — and the free
 * tier caps the newer models at roughly twenty requests A DAY, which is why the
 * default is a lite model. Writing a CV and a letter is two or three calls and
 * goes out under the user's name, so it can afford the better model without coming
 * anywhere near that cap.
 */
export async function complete(opts) {
  const purpose = opts.purpose || 'judge';
  const key = keyFor(purpose);
  if (!key) return { ok: false, error: purpose === 'apply' ? 'GEMINI_API_KEY_APPLY (or GEMINI_API_KEY_JUDGE) not set' : 'GEMINI_API_KEY_JUDGE not set', fatal: true };

  // Judging only, and only when switched on. Everything else is one key, one call.
  if (!(purpose === 'judge' && overflowOn())) return completeWith(opts, key);

  // The free project is known to be spent: don't spend a refused call finding out again.
  if (judgeSpent()) return viaBilled(opts);

  const r = await completeWith(opts, key);
  if (!(r.rateLimited && r.scope === 'day')) return r;

  // The free daily quota is gone. A per-minute limit is NOT a reason to switch — it clears
  // in seconds and the billed key would only be paying for a hiccup.
  markJudgeSpent();
  return viaBilled(opts);
}

/**
 * The call, on the billed key. A success is COUNTED (keystate.js): it is the one place this
 * tool spends money, so the count is kept where the page, the tray and `npm run keys` can
 * show it. A refused request is not charged and is not counted.
 */
async function viaBilled(opts) {
  const o = await completeWith(opts, process.env.GEMINI_API_KEY_APPLY);
  if (o.ok) {
    try { keystate.countBilled(); } catch { /* a count that cannot be saved must not lose the answer it paid for */ }
    return { ...o, overflow: true };
  }
  return o.rateLimited ? { ...o, overflow: true } : overflowFailed(o);
}

/**
 * Daily overflow from the free judging project to the billed one (the `_APPLY` key).
 *
 * Off unless `GEMINI_JUDGE_OVERFLOW_TO_APPLY` is on AND an apply key exists: this spends
 * money, so it is a choice and not a default. It switches on a spent DAILY quota only.
 * The calls use the judging model, not the apply model — it is the same cheap question
 * being asked, and `gemini-3.7-flash` would cost far more for it.
 */
const overflowOn = () => /^(true|1|yes|on)$/i.test((process.env.GEMINI_JUDGE_OVERFLOW_TO_APPLY || '').trim())
  && Boolean(process.env.GEMINI_API_KEY_APPLY);

/**
 * When the free judging project is next usable, remembered on disk. Without it every run
 * would begin by asking the spent project (two refused calls, since a 429 is retried once)
 * before switching. Midnight Pacific is when it resets, so that is when the memory ends.
 */
let spentUntil;
function judgeSpent(now = new Date()) {
  if (spentUntil === undefined) spentUntil = keystate.judgeSpentUntil(keystate.load(), now);
  return Boolean(spentUntil && spentUntil > now);
}
function markJudgeSpent() {
  spentUntil = nextQuotaReset();
  try { keystate.markJudgeSpent(spentUntil); } catch { /* remembered in memory for this run */ }
}

/**
 * The billed key failed for a reason of its own (invalid, no permission). That says
 * nothing about the posting, and falling back to rules would decide it on a failure of
 * ours — so report what is true: the free quota is spent. The postings wait for the reset.
 */
const overflowFailed = (o) => ({
  ok: false, rateLimited: true, scope: 'day', fatal: true, status: 429,
  error: `free daily quota spent, and the billed key could not take over (${o.error})`,
});

async function completeWith({ system, user, schema, model: wanted = null }, key) {

  // An explicitly requested model wins. resolvedModel is the substitute found
  // for the DEFAULT model, and letting it apply here would quietly drag the
  // caller back to the cheap model it deliberately opted out of.
  let model = wanted || resolvedModel || judgeEnv('GEMINI_MODEL') || DEFAULT_MODEL;

  const call = async (m) => httpJson(`${base()}/models/${m}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(schema),
        temperature: 0,
      },
    }),
    retries: 1,
  });

  let res = await call(model);

  // The model list moves faster than any hardcoded default. If the configured
  // name is gone, discover a live one once and reuse it for the whole run.
  if (!res.ok && res.status === 404) {
    const alt = await pickFallbackModel();
    if (alt && alt !== model) {
      // Remember what was asked for. Without this the substitution is invisible
      // and a typo in GEMINI_MODEL reads as "my setting is being ignored".
      fellBackFrom = model;
      // Only remember the substitution when it applies to everyone. A caller
      // that asked for a specific model and did not get it must not change
      // which model every other call uses.
      if (!wanted) resolvedModel = alt;
      model = alt;
      res = await call(model);
    }
  }

  // 429 on the free tier is almost always the PER-MINUTE limit, not the daily
  // quota — it clears in seconds. Treating it as fatal killed adjudication for
  // a whole run after one hiccup, so retry with the server's own retryDelay.
  let attempt = 0;
  while (!res.ok && res.status === 429 && !isDailyQuota(res) && attempt < 4) {
    attempt++;
    await sleep(retryDelayMs(res, attempt));
    res = await call(model);
  }

  if (!res.ok) {
    // A limit is not a verdict. It says nothing about THIS posting, only that the
    // project has run out of room for now, so the caller must hold the posting and
    // ask again later — never decide it. `rateLimited` is how it tells this apart
    // from a bad key (also fatal) or one posting the model could not read.
    //
    //   scope 'day'     the quota is spent until it resets: stop asking, everything
    //                   not yet reached waits for the reset.
    //   scope 'minute'  it outlasted its retries (each honours Google's retryDelay):
    //                   stop for now and come back in a few minutes.
    if (res.status === 429) {
      const day = isDailyQuota(res);
      return { ok: false, error: describeError(res), fatal: day, rateLimited: true, scope: day ? 'day' : 'minute', status: 429 };
    }
    // A bad key or a missing model will not get better by waiting.
    const fatal = [400, 401, 403, 404].includes(res.status);
    return { ok: false, error: describeError(res), fatal, status: res.status };
  }

  const cand = res.data?.candidates?.[0];
  if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') {
    return { ok: false, error: 'declined on safety grounds', fatal: false };
  }

  const text = cand?.content?.parts?.map((part) => part.text).join('') || '';
  if (!text) return { ok: false, error: 'empty response', fatal: false };

  try {
    return { ok: true, data: JSON.parse(text), model };
  } catch {
    return { ok: false, error: `unparseable JSON: ${text.slice(0, 80)}`, fatal: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The quota a 429 names, from its structured details.
 *
 * Google's own pages (rate limits, troubleshooting, API errors) say a 429 happens and how
 * to back off, but do NOT document the body. The shape below is what the API actually
 * returns, taken from a captured response (inspect_ai issue 5526):
 *
 *   error.status                       "RESOURCE_EXHAUSTED"
 *   error.message                      "You exceeded your current quota, please check your plan..."
 *   error.details[] @type QuotaFailure .violations[]:
 *       quotaId        "GenerateRequestsPerDayPerProjectPerModel-FreeTier"   (or ...PerMinute...)
 *       quotaValue     "20"
 *       quotaDimensions { model: "gemini-2.5-flash" }
 *   error.details[] @type RetryInfo    .retryDelay "34s"
 *
 * The message does NOT reliably say "per day" — the quota id does, so that is what is read.
 * A per-day violation also carries a retryDelay (34s in the capture), which means nothing
 * for a quota that resets at midnight.
 */
function quotaViolations(res) {
  try {
    const details = JSON.parse(res.text)?.error?.details;
    return (Array.isArray(details) ? details : [])
      .filter((d) => /QuotaFailure/.test(d?.['@type'] || ''))
      .flatMap((d) => (Array.isArray(d.violations) ? d.violations : []));
  } catch {
    return [];
  }
}

/** The free tier's per-day cap is terminal for the run; per-minute is not. */
function isDailyQuota(res) {
  const ids = quotaViolations(res).map((v) => String(v.quotaId || '')).filter(Boolean);
  // The structured answer wins when there is one. Any violation naming a day is a day:
  // a request refused by two quotas at once is refused until the longer one lifts.
  if (ids.length) return ids.some((id) => /PerDay|Daily/i.test(id));
  // No structure (a proxy, an older format, a different message): fall back to the words.
  const t = res.text || '';
  return /per\s*day|PerDay|daily limit|quota exceeded for quota metric.*per day/i.test(t);
}

/**
 * Gemini returns its own `retryDelay` in the error details ("21s"). Honour it
 * when present — guessing shorter just burns another request against the limit.
 */
function retryDelayMs(res, attempt) {
  try {
    const details = JSON.parse(res.text)?.error?.details || [];
    const info = details.find((d) => /RetryInfo/.test(d['@type'] || ''));
    const secs = parseFloat(String(info?.retryDelay || '').replace('s', ''));
    if (secs > 0) return Math.min(secs * 1000 + 500, 60000);
  } catch { /* fall through to backoff */ }
  return Math.min(4000 * attempt, 30000);
}

function describeError(res) {
  const msg = (() => {
    try { return JSON.parse(res.text)?.error?.message; } catch { return null; }
  })() || res.error;

  if (res.status === 400 && /API key not valid/i.test(msg || '')) return 'invalid API key';
  if (res.status === 429) {
    const v = quotaViolations(res).find((x) => /PerDay|Daily/i.test(String(x.quotaId || ''))) || quotaViolations(res)[0];
    const limit = v?.quotaValue ?? String(msg).match(/limit:\s*(\d+)/)?.[1];
    const model = v?.quotaDimensions?.model ?? String(msg).match(/model:\s*([\w.-]+)/)?.[1];
    if (isDailyQuota(res)) {
      const detail = [limit && `${limit}/day`, model].filter(Boolean).join(' on ');
      // Only suggest a different model when they are not already on the roomy
      // tier — telling someone to switch to the model they are using is noise.
      const alreadyLite = /lite/.test(model || resolvedModel || judgeEnv('GEMINI_MODEL') || '');
      return `daily free quota spent${detail ? ` (${detail})` : ''}`
        + (alreadyLite
          ? ' — resets at midnight Pacific (09:00 in Germany); the rest wait and are judged after the reset'
          : ' — a -lite model has a far larger allowance, e.g. GEMINI_MODEL_JUDGE=gemini-flash-lite-latest');
    }
    return 'rate limited (per-minute) — retried and still limited; the rest wait and are tried again shortly';
  }
  if (res.status === 403) return 'key lacks permission — check it is enabled for the Generative Language API';
  return `HTTP ${res.status}: ${String(msg).slice(0, 120)}`;
}

/**
 * Explicit on/off switch, read from <PROVIDER>_ENABLED in .env.
 * Defaults to on, so adding a key is enough to start using a provider; set it
 * to false to park one without deleting its credentials.
 */
export function enabled() {
  const v = process.env.GEMINI_ENABLED;
  if (v === undefined || v === '') return true;
  return !/^(false|0|no|off)$/i.test(v.trim());
}

/**
 * How many requests may be in flight at once.
 *
 * This was hardcoded to 1, with the note "free-tier Gemini is ~10 requests per
 * minute; parallelism just manufactures 429s". True at the time, and it stopped
 * being true the moment billing was enabled — but a constant cannot notice
 * that. It silently overrode `llm.concurrency: 4` in profile.json, so the
 * config said one thing and the run did another.
 *
 * Measured on the paid tier, same key, same model:
 *
 *   concurrency 1   20 calls   1144ms each      ~52 calls/min
 *   concurrency 4   20 calls   5.4s total      ~221 calls/min   0 errors
 *   concurrency 8   20 calls   3.1s total      ~387 calls/min   0 errors
 *
 * A run adjudicating 152 postings takes 174 seconds serially and 40 at four.
 *
 * The default stays 1, because that is correct for anyone on the free tier and
 * a wrong default there produces 429s rather than a slow run. Raise it in .env
 * once you are paying.
 *
 * A FUNCTION, not a constant, and that is the whole point. As a constant it was
 * evaluated when this module loaded — and index.js imports the provider chain
 * statically, so every one of those imports resolved before loadEnv() ran on
 * line 29. The .env value was set minutes too late to be seen, every run, and
 * the log went on reporting "capped at 1 by Gemini" to someone who had already
 * configured 4. Read it when it is asked for.
 */
export const maxConcurrency = () => Math.max(1, Number(judgeEnv('GEMINI_MAX_CONCURRENCY')) || 1);

// For tests: classifying a 429 is the part that must be right and does not need a network.
export const __testables = { isDailyQuota, quotaViolations, describeError };
