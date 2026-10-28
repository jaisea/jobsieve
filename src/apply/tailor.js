import { resolveChain } from '../providers/index.js';
import { readJson, p, log } from '../util.js';


/**
 * The two model calls: generate, then review.
 *
 * Generate is one call producing the resume edits AND the letter together, so
 * the two documents cannot drift into describing slightly different people. It
 * commits to a `storyline` first — one sentence naming the angle — and both
 * outputs follow from it.
 *
 * Review is deliberately separate. Folding a self-check into the call that
 * wrote the text is marking your own homework; a cold read against the master
 * data catches overclaiming that the deterministic check in verify.js cannot.
 */

const MAX_EDITS = 10;

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    storyline: { type: 'string', description: 'One sentence: the single angle both documents take. Max 25 words.' },
    resumeEdits: {
      type: 'array',
      description: `Only paragraphs worth changing for THIS posting. At most ${MAX_EDITS}. Leave everything else alone.`,
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The paragraph index given in the editable list.' },
          text: { type: 'string', description: 'The rewritten line ONLY. Do not repeat the [SECTION] label from the list — it identifies the line for you, it is not part of it.' },
          why: { type: 'string', description: 'Max 12 words: which part of the posting this serves.' },
        },
        required: ['index', 'text', 'why'],
        additionalProperties: false,
      },
    },
    letter: {
      type: 'object',
      properties: {
        opening: { type: 'string', description: '45-75 words. Why this role, naming it and the company, and what the candidate brings to it. NO greeting line — the template already contains "Dear Hiring Manager," and yours would duplicate it.' },
        experience: { type: 'string', description: '80-120 words. Name a specific thing the candidate BUILT and what it changed. Not a list of duties, not a list of tools.' },
        draw: { type: 'string', description: '50-90 words. What genuinely draws the candidate. Name something real about this company or this problem. Do NOT paraphrase the job description back at them — that is the single most common failure.' },
        close: { type: 'string', description: '30-50 words. Work rights and notice period, then a short close. NO sign-off and NO name — the template already ends with "Best," and the candidate name, and yours would duplicate them.' },
      },
      required: ['opening', 'experience', 'draw', 'close'],
      additionalProperties: false,
    },
  },
  required: ['storyline', 'resumeEdits', 'letter'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    overall: { type: 'string', enum: ['pass', 'revise'], description: 'revise if anything would embarrass the candidate in an interview' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string', description: 'Which line or paragraph.' },
          kind: { type: 'string', enum: ['overclaim', 'unsupported', 'tone', 'generic', 'contradiction'] },
          detail: { type: 'string', description: 'Max 25 words, quoting the problem.' },
        },
        required: ['where', 'kind', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['overall', 'findings'],
  additionalProperties: false,
};

/**
 * master.json minus the parts a model has no use for.
 *
 * Name, email, phone and LinkedIn are already in the .docx, in paragraphs this
 * feature never touches — sending them accomplishes nothing and puts contact
 * details in a provider's request logs. Work rights and notice period stay,
 * because the user's own letters cite both.
 */
export function leanMaster(master) {
  const strip = (o) => (Array.isArray(o) ? o.map(strip)
    : o && typeof o === 'object'
      ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, strip(v)]))
      : o);

  const lean = strip(master);
  lean.identity = {
    workRights: master.identity?.workRights,
    noticePeriod: master.identity?.noticePeriod,
    location: master.identity?.location,
  };
  // Voice samples are supplied separately, chosen by relevance.
  delete lean.voice.samples;
  delete lean.recoveredDetail;

  // Client names are withheld from the provider, the same decision that deletes
  // recoveredDetail above: who someone worked FOR is a different disclosure from
  // what they did, and some of it may sit under an NDA. The work
  // survives, attributed to the employer, which is what a letter needs anyway.
  if (lean.disasterRecovery?.employers) {
    lean.disasterRecovery.employers = lean.disasterRecovery.employers.map(({ client, ...rest }) => rest);
  }

  return lean;
}

/** Pick the letters closest to this posting — showing the voice beats describing it. */
export function pickSamples(master, job, n = 2) {
  const hay = `${job.title} ${job.descriptionText || ''}`.toLowerCase();
  const score = (s) => s.forRoles.split(/,\s*/).reduce((acc, term) => acc + (hay.includes(term.split(/\s+/)[0]) ? 1 : 0), 0);
  return [...(master.voice?.samples || [])].sort((a, b) => score(b) - score(a)).slice(0, n);
}

/**
 * Corrections the user has made repeatedly, folded back into the prompt.
 *
 * Only rules marked active — three occurrences — appear. A single edit is a
 * preference for one letter; turning every correction into an instruction
 * produces a prompt full of contradictory micro-rules that makes the output
 * worse, not better.
 */
function learnedRules() {
  const notes = readJson(p('config', 'style-notes.json'), { rules: [] });
  const active = (notes.rules || []).filter((r) => r.active);
  if (!active.length) return '';

  return `# Corrections the candidate has made more than once — follow these
${active.map((r) => `- the candidate replaced "${String(r.generated).slice(0, 90)}" with "${String(r.yours).slice(0, 90)}"`).join('\n')}

`;
}

function systemPrompt(master, samples) {
  const v = master.voice || {};
  return `You are helping one candidate apply for one job. You tailor their existing CV and write their cover letter. You never invent anything.

# The ONLY technologies you may name
${(master.facts?.technologies || []).join(' · ')}

Anything not on that list is an invention, however much the posting asks for it, and the
document will be refused before it reaches a PDF. The posting's stack is not the candidate's stack.
Where the posting names something the candidate has not used, write about the nearest thing they HAVE
used, or leave it out — do not reach for the posting's vocabulary to fill the gap. Real
refusals: "Microsoft Copilot", "AI agents", "Pulumi".

# Absolute rules
- Every technology you mention must already appear in the candidate's master data or in the line you are rewriting. If the posting wants something they have not used, do NOT claim it.
- Every number must already appear in the candidate's master data. Never invent a team size, a percentage, a saving or a duration.
- Never change an employer, a job title or a date.
- Rewrite a bullet to use the posting's vocabulary and to foreground what the posting cares about. Keep the same underlying fact and roughly the same length. This is keyword insertion and emphasis, NOT a new CV.
- Change only what earns it. Most bullets should be left alone; at most ${MAX_EDITS} edits.

# The FIRST summary line is the candidate's identity, not a keyword slot
It is the most-read line on the CV and it states who the candidate is. Their title — "${master.positioning?.headline?.split(' with ')[0] || 'their current title'}" — must survive unchanged. Do not re-title the candidate to match the job advert.

You may adjust what FOLLOWS the title. You may not weaken it. A real failure to avoid: "Cloud / Platform Engineering lead with 12 years building and running cloud platforms" became "Infrastructure platform engineering leader with 12 years administering enterprise Linux environments, virtualization, storage" — that re-titled the candidate AND traded "designing and operating" for "administering", which reads as a demotion.

Never replace a strong verb with a weaker one. designing, architecting, building, leading, establishing OUTRANK administering, supporting, maintaining, assisting. Put the posting's keywords in the later summary lines, where they cost nothing.

# What the candidate is looking for
${master.motivations?.wantNext || ''}

# What the candidate does NOT want — never write that they are drawn to any of these
${(master.motivations?.avoid || []).join(', ') || '(nothing recorded)'}

# A side project the candidate may cite, framed honestly
${(master.sideProjects || []).map((s) => `${s.name} (${s.public}): ${s.what} ${s.llmWork} FRAMING: ${s.honest}`).join('\n')}

# Familiar with, but has NOT used in production — never claim these as experience
${(master.facts?.familiar || []).join(', ') || '(nothing recorded)'}
The candidate uses these personally but has not built or operated anything with them. If the posting
wants them, that is a gap to be honest about, not a claim to make.

${master.angle ? `# How to angle it — IMPORTANT, and never state this in the letter
${master.angle}
` : ''}
# The candidate's signature pattern — lead with this when the posting describes something to be built or fixed
${master.signature?.pattern || ''}
In their own words: ${(master.signature?.phrases || []).map((p) => `"${p}"`).join(', ')}.
Evidenced at: ${(master.signature?.evidence || []).map((e) => e.employer).join(', ')}.

# Voice
Write as the candidate writes. Study the sample letters below and match them.
- **LENGTH: the four paragraphs together must total ${v.measured?.medianWords || 246} words, minimum ${(v.measured?.range || [200, 380])[0]}.** A first attempt came back at 143 words and read as a stub. Each paragraph has a word range in the schema — respect it.
- Sentences average ${v.measured?.avgSentenceWords || 20} words. First person throughout. Contractions are fine where the samples use them.
- English always, even for a German-language posting.
- Never use: ${(v.banned?.phrases || []).join(', ')}.
- The "draw" paragraph must name something REAL about this company or this work. If the posting gives you nothing specific, say what about the WORK draws the candidate instead. Never write generic praise.

# The commonest failure, so check for it before you answer
Reflecting the job description back. A first attempt produced "Acme Security's focus on securing SAP environments through robust Linux administration, virtualization, and automation is what draws me" — that is the posting's own words rearranged, and it tells the reader nothing they did not write themselves.

Say instead what the CANDIDATE brings or wants that the posting implies but does not state. Look at the signature pattern: if the company is building or fixing something, that is the connection. A good "draw" names the company's concrete initiative — "What really drew me to you is your focus on building an Internal Developer Platform with self-service capabilities" — and then says what the candidate thinks about that. The opinion is what makes it theirs.

${learnedRules()}
# Sample letters the candidate actually sent
${samples.map((s, i) => `--- sample ${i + 1} (${s.forRoles}) ---\n${s.text}`).join('\n\n')}

# The candidate's master data
${JSON.stringify(leanMaster(master))}`;
}

/**
 * The rest of the CV, as background it may read but not touch.
 *
 * Only the editable lines used to be sent — 31 paragraphs of 98 — so the model
 * never saw the skills section, the certifications or the other employers. It
 * was rewriting a document it could not read, and repeated things the CV
 * already said elsewhere. The same blind spot made the reviewer call the
 * candidate's own words unsupported.
 *
 * The contact line is left out. Name, email, phone and LinkedIn are stripped
 * from master.json before it is sent, deliberately, and sending the whole CV
 * would put them straight back into a provider's request logs.
 */
function background(allParagraphs, editableIndexes) {
  const CONTACT = /@|\+\d{2}\s|linkedin\.com/i;
  return (allParagraphs || [])
    .filter((x) => !editableIndexes.has(x.index))
    .map((x) => String(x.text || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 2 && !CONTACT.test(t))
    .join('\n');
}

function userPrompt(job, editable, allParagraphs = null) {
  const lines = [
    ...editable.summary.map((s) => `${s.index}\t[SUMMARY] ${s.text}`),
    ...editable.employers.flatMap((e) => e.bullets.map((b) => `${b.index}\t[${e.name}] ${b.text}`)),
  ].join('\n');

  const editableIndexes = new Set([
    ...editable.summary.map((s) => s.index),
    ...editable.employers.flatMap((e) => e.bullets.map((b) => b.index)),
  ]);
  const rest = allParagraphs ? background(allParagraphs, editableIndexes) : '';

  return `# The posting
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}${job.workMode ? ` (${job.workMode})` : ''}

${(job.descriptionText || '(no description supplied — work from the title and company alone, and say so in your storyline)').slice(0, 6000)}

${rest ? `# The rest of the candidate's CV — READ ONLY, do not return edits for any of this
It is here so you know what the document already says. Do not repeat something it
covers elsewhere, and do not contradict it. Anything named here is the candidate's.

${rest}

` : ''}# CV paragraphs you may edit
Index, section, current text. Return edits only for the ones worth changing.

${lines}

Produce the storyline, the resume edits, and the four letter paragraphs.`;
}

/**
 * The model used for WRITING, which may differ from the one used for judging.
 *
 * Judging runs about twenty calls per search and only decides what the user reads.
 * Writing runs two or three per application and is what an employer sees, so
 * the better model belongs here and the cheap one belongs there. The free tier
 * draws the same line: the newer models cap at roughly twenty requests a day,
 * which judging would exhaust in one run and writing would never approach.
 *
 * Unset means "use whatever judging uses", so nothing changes until it is set.
 */
const writingModel = () => process.env.GEMINI_MODEL_APPLY || null;

/** Resolve and call the provider the same way adjudication does. */
async function call({ system, user, schema, label }) {
  // resolveChain returns { chain, unknown, disabled } — not a bare array.
  const { chain, unknown } = resolveChain();
  for (const u of unknown) log.warn(`  unknown provider "${u}" in LLM_PROVIDERS — ignored`);
  if (!chain.length) throw new Error('no LLM provider configured — set GEMINI_API_KEY_JUDGE in .env. Unlike search, this command has no rules fallback: a form letter is worse than none.');

  const errors = [];
  for (const provider of chain) {
    const res = await provider.complete({ system, user, schema, model: writingModel(), purpose: 'apply' });
    // The prompt travels back with the answer. Every application folder kept
    // the generated text, what was flagged and the model name, but not the
    // instructions that produced any of it — so "why did it write that?" was
    // unanswerable after the fact, which is the one question worth asking of a
    // letter that went out under the user's name.
    if (res.ok) return { data: res.data, provider: provider.id, model: res.model, sent: { system, user } };
    errors.push(`${provider.label}: ${res.error}`);
    if (!res.fatal) break;
  }
  throw new Error(`${label} failed — ${errors.join('; ')}`);
}

export async function generate({ job, master, editable, allParagraphs = null, verbose = false }) {
  const samples = pickSamples(master, job);
  if (verbose) log.dim(`    voice samples: ${samples.map((s) => s.id).join(', ')}`);

  return call({
    system: systemPrompt(master, samples),
    user: userPrompt(job, editable, allParagraphs),
    schema: GENERATE_SCHEMA,
    label: 'generation',
  });
}

/**
 * One bounded retry, naming exactly what was refused.
 *
 * A blocked document is a dead end: the .docx is written, no PDF appears, and
 * the only way on is a full --refresh that produces an unrelated draft. The
 * model is not usually being stubborn — it reached for the posting's vocabulary
 * to fill a gap. Told which words were refused and why, it can nearly always
 * say the same thing with words the candidate owns.
 *
 * ONE attempt, and only when something blocked. Looping here would spend calls
 * arguing with a check that is deliberately stricter than the model.
 */
export async function repair({ job, master, editable, draft, issues, allParagraphs = null }) {
  const samples = pickSamples(master, job);
  const named = issues.map((i) => `- ${i.kind}: ${i.detail}`).join('\n');
  const edits = draft.resumeEdits.map((e) => `[${e.index}] ${e.text}`).join('\n');

  return call({
    system: systemPrompt(master, samples),
    user: `${userPrompt(job, editable, allParagraphs)}

# YOUR PREVIOUS ANSWER WAS REFUSED
You wrote:

${JSON.stringify(draft.letter, null, 1)}

${edits}

It was refused for these reasons:
${named}

Produce the whole answer again, saying the same things with words the candidate owns. Do not simply
delete the offending sentence and leave a gap — replace the claim with a real one from the
master data. Everything that was not objected to should survive largely as it was.`,
    schema: GENERATE_SCHEMA,
    label: 'repair',
  });
}

/**
 * `original` is the CV text the edits were made FROM, and leaving it out made
 * the reviewer wrong.
 *
 * It judged the draft against master.json alone, so a bullet reworded from the
 * user's own CV was flagged as unsupported whenever master.json did not happen to
 * repeat the same words. In one model comparison it raised four findings and
 * three were false: "load balancers" is at CV paragraph 22 and "EC2" at 45,
 * neither appears in master.json, and the model was marked down for keeping
 * words the user's own CV already used. A reviewer that cries wolf over rewording
 * teaches you to ignore it.
 */
export async function review({ job, master, draft, original = '' }) {
  const letter = Object.values(draft.letter).join('\n\n');
  const edits = draft.resumeEdits.map((e) => `- ${e.text}`).join('\n');

  return call({
    system: `You are checking a cover letter and CV edits before they are sent to an employer. You are sceptical. Your job is to catch anything the candidate would struggle to defend in an interview.

Flag:
- overclaim — implies more seniority, ownership or scope than the master data supports ("architected" where the candidate contributed, "led" where they participated)
- unsupported — a claim with no basis in the master data
- contradiction — disagrees with the master data or with the CV
- generic — could have been written for any company; the "draw" paragraph is the usual offender
- tone — reads as machine-written rather than as the candidate

Do not flag things that are merely rephrased. Return "pass" only if you would be comfortable being interviewed on every sentence.

# Master data
${JSON.stringify(leanMaster(master))}

# The CV lines these edits were made FROM
Anything already present here is THE CANDIDATE'S, whether or not the master data repeats it. Rewording
one of these lines is the whole job. Flag it only if the meaning changed or the claim grew.
${original || '(not supplied)'}`,
    user: `# Posting
${job.title} at ${job.company}

# Storyline
${draft.storyline}

# Cover letter
${letter}

# CV lines as rewritten
${edits}`,
    schema: REVIEW_SCHEMA,
    label: 'review',
  });
}

export const __testables = { leanMaster, pickSamples, systemPrompt, userPrompt, GENERATE_SCHEMA, MAX_EDITS };
