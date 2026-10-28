import { slug, canonicalTitle, daysSince, parseDate, hasPhrase, hasSkill } from './util.js';

/**
 * 0-100 match score with a transparent breakdown — every card shows why it got
 * the number, so the weights in config/profile.json can be tuned with evidence.
 */
export function score(job, profile) {
  const cfg = profile.scoring;
  const parts = [];

  const titleS = titleScore(job, profile, cfg.titleMax);
  parts.push(titleS);

  const skillS = skillScore(job, profile, cfg.skillsMax);
  parts.push(skillS);

  const locS = locationScore(job, profile, cfg.locationMax);
  parts.push(locS);

  const freshS = freshnessScore(job, cfg);
  parts.push(freshS);

  const bonuses = bonusScore(job, profile);
  const penalties = penaltyScore(job, profile);

  const total = Math.max(
    0,
    Math.min(100, Math.round(
      titleS.points + skillS.points + locS.points + freshS.points +
      bonuses.reduce((n, b) => n + b.points, 0) +
      penalties.reduce((n, b) => n + b.points, 0)
    ))
  );

  return {
    score: total,
    matchedSkills: skillS.matched,
    scoreBreakdown: [...parts, ...bonuses, ...penalties].filter((x) => x.points !== 0 || x.always),
  };
}

/**
 * Tokens too generic to identify a role on their own. A target that reduces to
 * one of these would match every posting ending in "…Engineer", so it is skipped
 * rather than silently scoring everything at full marks.
 */
const GENERIC_TOKENS = new Set([
  'engineer', 'developer', 'manager', 'architect', 'lead', 'specialist',
  'consultant', 'analyst', 'administrator', 'expert', 'officer',
]);

function titleScore(job, profile, max) {
  const jobTokens = new Set(canonicalTitle(job.title).split(' ').filter(Boolean));
  const full = slug(job.title);
  const { strong, good } = profile.targetTitles;

  // Every token of the target must be present in the job title. Substring
  // matching is deliberately avoided: it made "Staff Engineer" match anything.
  const hit = (list) => list.find((x) => {
    const toks = canonicalTitle(x).split(' ').filter(Boolean);
    if (!toks.length) return false;
    if (toks.length === 1 && GENERIC_TOKENS.has(toks[0])) return false;
    return toks.every((tok) => jobTokens.has(tok)) || hasPhrase(full, x);
  });

  const s = hit(strong);
  if (s) return { label: `Title: ${s}`, points: max, always: true };

  const g = hit(good);
  if (g) return { label: `Title: ${g}`, points: Math.round(max * 0.65), always: true };

  // Partial credit for the field's vocabulary even if the title is unusual.
  const kw = profile.relevance?.domainTerms || [];
  const found = kw.filter((k) => hasPhrase(full, k));
  if (found.length) {
    return { label: `Title keywords: ${found.slice(0, 3).join(', ')}`, points: Math.round(max * 0.35), always: true };
  }
  return { label: 'Title: weak match', points: 0, always: true };
}

function skillScore(job, profile, max) {
  const hay = `${job.title} ${job.descriptionText}`;
  // The one shared matcher. There used to be separate copies of this regex and
  // they had drifted — one tolerated a trailing plural and this did not, so the
  // two disagreed about whether "containers" was a match.
  const has = (skill) => hasSkill(hay, skill);

  // Flattened across KIND, because scoring cares only about WEIGHT: a tool and
  // a practice at the same tier are worth the same.
  // Deduplicated by slug, because that is what the matcher compares on.
  // "ci/cd", "ci cd" and "ci-cd" are one concept spelled three ways — slug()
  // flattens punctuation, so all three matched the same mention and a posting
  // whose only skill was CI/CD scored 10 points as "3 core skills" instead of
  // 3.2 as one. The gate already deduped; this did not.
  //
  // Both halves of that are now handled further down the stack: hasSkill()
  // treats the separator inside a term as OPTIONAL, so one entry — "ci/cd",
  // "argo cd" — covers every spelling an advert uses, and the pairs that had to
  // coexist for that reason are gone from the config.
  const tier = (name) => {
    const out = new Map();
    for (const s of [
      ...(profile.skills.tools?.[name] || []),
      ...(profile.skills.practices?.[name] || []),
      ...(profile.skills.adjacent?.[name] || []),
    ]) {
      const k = slug(s);
      if (k && !out.has(k)) out.set(k, s);
    }
    return [...out.values()];
  };

  const core = tier('core').filter(has);
  const secondary = tier('secondary').filter(has);
  const nice = tier('nice').filter(has);

  // Core skills carry most of the weight; the long tail saturates quickly.
  const rawPoints = core.length * 3.2 + secondary.length * 1.1 + nice.length * 0.5;
  const points = Math.min(max, Math.round(rawPoints));

  const matched = [...core, ...secondary, ...nice];
  return {
    label: `Skills: ${core.length} core, ${secondary.length} secondary${nice.length ? `, ${nice.length} adjacent` : ''}`,
    points,
    matched,
    always: true,
  };
}

function locationScore(job, profile, max) {
  // The city name comes from the profile. It used to be written into these
  // three labels, which is the one place a relocating user would see the tool
  // confidently naming the wrong town.
  const { radiusKm, city } = profile.location;

  if (job.workMode === 'remote') {
    if (job.remoteScope === 'DE') return { label: 'Remote (Germany)', points: max, always: true };
    if (job.remoteScope === 'EU') return { label: 'Remote (EU/EMEA)', points: Math.round(max * 0.85), always: true };
    if (job.remoteScope === 'worldwide') return { label: 'Remote (worldwide)', points: Math.round(max * 0.7), always: true };
    return { label: 'Remote (scope unstated)', points: Math.round(max * 0.6), always: true };
  }

  if (job.distanceKm !== null) {
    const d = job.distanceKm;
    const mode = job.workMode === 'hybrid' ? 'Hybrid' : 'Onsite';
    if (d <= 15) return { label: `${mode} in ${city} (${d}km)`, points: max, always: true };
    if (d <= 35) return { label: `${mode} ${d}km from ${city}`, points: Math.round(max * 0.85), always: true };
    if (d <= radiusKm) return { label: `${mode} ${d}km from ${city}`, points: Math.round(max * 0.6), always: true };
  }
  return { label: 'Location unclear', points: Math.round(max * 0.25), always: true };
}

function freshnessScore(job, cfg) {
  const age = daysSince(parseDate(job.postedAt));
  if (age === null) return { label: 'Posted date unknown', points: Math.round(cfg.freshnessMax * 0.4), always: true };
  if (age <= cfg.freshFullDays) return { label: `Posted ${Math.max(0, Math.round(age))}d ago`, points: cfg.freshnessMax, always: true };
  if (age >= cfg.freshZeroDays) return { label: `Posted ${Math.round(age)}d ago`, points: 0, always: true };
  const span = cfg.freshZeroDays - cfg.freshFullDays;
  const pts = Math.round(cfg.freshnessMax * (1 - (age - cfg.freshFullDays) / span));
  return { label: `Posted ${Math.round(age)}d ago`, points: pts, always: true };
}

function bonusScore(job, profile) {
  const hay = ` ${slug(`${job.title} ${job.descriptionText}`)} `;
  const out = [];

  // Depth in the core stack, not just a passing mention: core tools named three
  // or more times each.
  const depth = (profile.skills?.tools?.core || []).map(slug).filter(Boolean).filter((k) => {
    const m = hay.match(new RegExp(`(^|\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'g'));
    return m && m.length >= 3;
  });
  if (depth.length >= 2) out.push({ label: `Deep ${depth.slice(0, 3).join(' + ')} focus`, points: 5 });

  // For a candidate who needs no sponsorship, postings that stress work
  // authorisation are a filter-in: they thin out the competition.
  if (/\b(no (visa )?sponsorship|must (already )?have (the )?right to work|work permit required|eu work authorization|arbeitserlaubnis)\b/.test(hay)) {
    out.push({ label: 'Work-authorisation required — no sponsorship needed', points: 4 });
  }

  // Domain overlap with the profile's `domainBonus` terms.
  const dom = profile.domainBonus.terms.filter((t) => hasPhrase(hay, t));
  if (dom.length) out.push({ label: `Domain overlap: ${dom.slice(0, 3).join(', ')}`, points: profile.domainBonus.points });

  // Leadership — rewarded for profiles with ten or more years of experience.
  if (/\b(lead|leading|mentor|mentoring|team lead|manage a team|head of)\b/.test(hay) && profile.yearsExperience >= 10) {
    out.push({ label: 'Leadership scope', points: 3 });
  }

  return out;
}

function penaltyScore(job, profile) {
  const hay = ` ${slug(`${job.title} ${job.descriptionText}`)} `;
  const out = [];

  if (job.germanRequired === 'conversational') out.push({ label: 'German B2 wanted', points: -8 });
  else if (job.germanRequired === 'basic') out.push({ label: 'German basic mentioned', points: -2 });

  // Programming as a nice-to-have is a mismatch signal for an operations-leaning
  // role and the whole job for a developer one, so it costs points only when the
  // profile says so (avoid.penaltyNiceToHaveProgramming).
  if (job.programmingRequired === 'niceToHave' && profile.avoid?.penaltyNiceToHaveProgramming) {
    out.push({
      label: `Programming mentioned (${job.programmingLanguage || 'nice-to-have'})`,
      points: profile.avoid.penaltyNiceToHaveProgramming,
    });
  }

  if (/\b(freelance|contract|contractor|befristet|interim|zeitarbeit|arbeitnehmerueberlassung)\b/.test(hay)) {
    out.push({ label: 'Contract / temporary', points: -6 });
  }
  if (job.workMode === 'unknown') out.push({ label: 'Work mode unclear', points: -3 });

  return out;
}
