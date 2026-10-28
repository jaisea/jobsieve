import { httpJson, stripHtml, pool } from '../util.js';

/**
 * Company career pages, via the public JSON APIs their applicant-tracking
 * systems expose. This is the reliable way to cover "company websites" — no
 * scraping, no keys, and the descriptions are complete rather than truncated.
 *
 * All five verified reachable during planning. Slugs must be DISCOVERED, not
 * guessed: `figma` and `ramp` 404 on Lever while `plaid` returns 200.
 */
export const id = 'ats';
export const label = 'Company boards';

/** HTML entities must be decoded BEFORE tag-stripping for Greenhouse. */
const decodeEntities = (s = '') =>
  String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

export const ATS = {
  greenhouse: {
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    probe: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    count: (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null),
    parse: (d, slug, name) => (d.jobs || []).map((j) => {
      const html = decodeEntities(j.content || '');
      return {
        sourceId: `greenhouse:${slug}:${j.id}`,
        title: j.title,
        company: j.company_name || name || slug,
        location: j.location?.name || '',
        descriptionHtml: html,
        descriptionText: stripHtml(html),
        applyUrl: j.absolute_url,
        postedAt: j.first_published || j.updated_at,
      };
    }),
  },

  lever: {
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    probe: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
    count: (d) => (Array.isArray(d) ? d.length : null),
    parse: (d, slug, name) => (Array.isArray(d) ? d : []).map((j) => ({
      sourceId: `lever:${slug}:${j.id}`,
      title: j.text,
      company: name || slug,
      location: j.categories?.location || '',
      employmentType: j.categories?.commitment || null,
      workMode: j.workplaceType === 'remote' ? 'remote' : j.workplaceType === 'hybrid' ? 'hybrid' : null,
      descriptionHtml: j.description || '',
      descriptionText: j.descriptionPlain || stripHtml(j.description || ''),
      applyUrl: j.hostedUrl || j.applyUrl,
      postedAt: j.createdAt,
    })),
  },

  ashby: {
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    probe: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    count: (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null),
    parse: (d, slug, name) => (d.jobs || []).filter((j) => j.isListed !== false).map((j) => ({
      sourceId: `ashby:${slug}:${j.id}`,
      title: j.title,
      company: name || slug,
      location: j.location || '',
      isRemote: j.isRemote === true,
      workMode: j.isRemote ? 'remote' : j.workplaceType === 'Hybrid' ? 'hybrid'
        : j.workplaceType === 'Onsite' ? 'onsite' : null,
      employmentType: j.employmentType || null,
      descriptionHtml: j.descriptionHtml || '',
      descriptionText: j.descriptionPlain || stripHtml(j.descriptionHtml || ''),
      applyUrl: j.applyUrl || j.jobUrl,
      postedAt: j.publishedAt,
    })),
  },

  smartrecruiters: {
    url: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
    probe: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
    // `totalFound` first, because the PROBE asks for limit=1 and content.length
    // is therefore always 1. Every SmartRecruiters board on the watchlist was
    // recorded as "serves 1 posting — a stub" for that reason, including
    // haufegroup, which actually has 33. A count
    // that is a property of the query rather than of the board is not a count.
    count: (d) => (Number.isFinite(d?.totalFound) ? d.totalFound
      : (Array.isArray(d?.content) ? d.content.length : null)),
    parse: (d, slug, name) => (d.content || []).map((j) => ({
      sourceId: `smartrecruiters:${slug}:${j.id}`,
      title: j.name,
      company: j.company?.name || name || slug,
      location: [j.location?.city, j.location?.region, j.location?.country]
        .filter(Boolean).join(', '),
      workMode: j.location?.remote === true ? 'remote' : null,
      employmentType: j.typeOfEmployment?.label || null,
      // The list endpoint carries no description; enrichDetail() fills it in
      // only for postings that survive the title gate, to keep call counts sane.
      descriptionHtml: '',
      descriptionText: '',
      applyUrl: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      postedAt: j.releasedDate,
      _detailUrl: `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`,
    })),
  },

  recruitee: {
    url: (slug) => `https://${slug}.recruitee.com/api/offers/`,
    probe: (slug) => `https://${slug}.recruitee.com/api/offers/`,
    count: (d) => (Array.isArray(d?.offers) ? d.offers.length : null),
    parse: (d, slug, name) => (d.offers || []).map((j) => {
      const html = `${j.description || ''}\n${j.requirements || ''}`;
      return {
        sourceId: `recruitee:${slug}:${j.id}`,
        title: j.title,
        company: j.company_name || name || slug,
        location: [j.city, j.country_code].filter(Boolean).join(', '),
        workMode: j.remote === true ? 'remote' : null,
        employmentType: j.employment_type_code || null,
        descriptionHtml: html,
        descriptionText: stripHtml(html),
        applyUrl: j.careers_url || j.careers_apply_url,
        postedAt: j.published_at,
      };
    }),
  },

  /* ---------------------------------------------------------------------
   * UNVERIFIED, AND COVERING NOBODY. Read this before relying on them.
   *
   * These three come from career-ops' discovery guide, which documents the
   * endpoints but tracks **zero companies on any of them** -- so the shapes
   * below are transcribed from a table, not from a response. Nothing on this
   * project's watchlist uses them either.
   *
   * They are here because a provider costs one entry and the first company
   * `discover` finds on one of them then works. But two honest caveats:
   *
   *   - `parse()` is a guess until a real board is seen. Expect to fix it the
   *     first time one appears, and do not read a 0 from them as "no jobs".
   *   - The `candidates` probe is a CROSS PRODUCT of slugs x platforms
   *     (src/index.js:802), so each of these adds 77 requests to every
   *     `npm run discover` run while covering nothing. If discover gets slow,
   *     this is why, and deleting them is the fix.
   *
   * The opposite of dead config would be to delete them; they earn their keep
   * the day a slug resolves. -- added 2026-09-29
   * ------------------------------------------------------------------- */

  bamboohr: {
    url: (slug) => `https://${slug}.bamboohr.com/careers/list`,
    probe: (slug) => `https://${slug}.bamboohr.com/careers/list`,
    count: (d) => (Array.isArray(d?.result) ? d.result.length : null),
    parse: (d, slug, name) => (d.result || []).map((j) => ({
      sourceId: `bamboohr:${slug}:${j.id}`,
      title: j.jobOpeningName,
      company: name || slug,
      location: [j.location?.city, j.location?.state, j.location?.country]
        .filter(Boolean).join(', '),
      workMode: j.isRemote === true || j.isRemote === 'true' ? 'remote' : null,
      employmentType: j.employmentStatusLabel || null,
      // The list carries no body; the detail endpoint is
      // /careers/{id}/detail and would need an enrichDetail pass like
      // SmartRecruiters has. Not written, because there is no board to test it.
      descriptionHtml: '',
      descriptionText: '',
      applyUrl: `https://${slug}.bamboohr.com/careers/${j.id}`,
      postedAt: j.datePosted || null,
    })),
  },

  breezy: {
    url: (slug) => `https://${slug}.breezy.hr/json`,
    probe: (slug) => `https://${slug}.breezy.hr/json`,
    count: (d) => (Array.isArray(d) ? d.length : null),
    parse: (d, slug, name) => (Array.isArray(d) ? d : []).map((j) => {
      const html = j.description || '';
      return {
        sourceId: `breezy:${slug}:${j.id || j.friendly_id || j.url}`,
        title: j.name,
        company: name || slug,
        location: j.location?.name || '',
        workMode: j.location?.is_remote === true ? 'remote' : null,
        employmentType: j.type?.name || null,
        descriptionHtml: html,
        descriptionText: stripHtml(html),
        applyUrl: j.url,
        postedAt: j.published_date || null,
      };
    }),
  },

  /* Teamtailor is NOT here, and that is the point of this note.
   *
   * It publishes RSS, so it cannot go through httpJson() like every other row
   * in this table -- a `url()` here would be fetched as JSON, fail, and report
   * the same "unexpected shape" a dead board does. It lives in
   * src/sources/teamtailor.js instead, the same shape as personio.js.
   *
   * Worth leaving written down: the rule is the transport, not the vendor. A
   * platform that publishes XML needs its own reader no matter how much its
   * endpoint looks like the others in the guide that listed it. */
};

/** Does this company actually have a board on this ATS? Used by `discover`. */
export async function probe(ats, slug) {
  const def = ATS[ats];
  if (!def) return { ok: false, error: `unknown ATS ${ats}` };
  const res = await httpJson(def.probe(slug));
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const n = def.count(res.data);
  if (n === null) return { ok: false, status: res.status, error: 'unexpected shape' };
  return { ok: true, count: n };
}

export async function fetchJobs({ boards = [], concurrency = 4, titleFilter = null } = {}) {
  const errors = [];
  const out = [];

  const results = await pool(boards, concurrency, async (b) => {
    const def = ATS[b.ats];
    if (!def) return { error: `unknown ATS ${b.ats}` };
    const res = await httpJson(def.url(b.slug));
    if (!res.ok) return { error: `${b.ats}/${b.slug}: ${res.error}` };
    try {
      return { jobs: def.parse(res.data, b.slug, b.name), board: b };
    } catch (e) {
      return { error: `${b.ats}/${b.slug}: parse failed — ${e.message}` };
    }
  });

  for (const r of results) {
    if (!r || r.__error) { errors.push(r?.__error || 'unknown failure'); continue; }
    if (r.error) { errors.push(r.error); continue; }
    for (const j of r.jobs) {
      out.push({
        ...j,
        source: id,
        sourceLabel: `${r.board.name || r.board.slug} (${r.board.ats})`,
        board: r.board,
      });
    }
  }

  // SmartRecruiters list responses have no description — fetch detail only for
  // the handful that look relevant, so one board costs a few calls, not 100.
  const needDetail = out.filter((j) => j._detailUrl && (!titleFilter || titleFilter(j.title)));

  // Anything past the ceiling was never ASKED about, and emitting it with an
  // empty description would have it judged — or parked — on a blank it was
  // never given a chance to fill. Both new scraping sources were written to say
  // so out loud; this one still truncated in silence.
  const MAX_DETAIL = 40;
  if (needDetail.length > MAX_DETAIL) {
    errors.push(`${needDetail.length - MAX_DETAIL} posting(s) over the ${MAX_DETAIL}-detail ceiling — judged without their advert`);
  }

  if (needDetail.length) {
    await pool(needDetail.slice(0, MAX_DETAIL), concurrency, async (j) => {
      const res = await httpJson(j._detailUrl);
      if (!res.ok) return;
      const d = res.data;
      const html = [
        d.jobAd?.sections?.companyDescription?.text,
        d.jobAd?.sections?.jobDescription?.text,
        d.jobAd?.sections?.qualifications?.text,
        d.jobAd?.sections?.additionalInformation?.text,
      ].filter(Boolean).join('\n');
      j.descriptionHtml = html;
      j.descriptionText = stripHtml(html);
    });
  }
  for (const j of out) delete j._detailUrl;

  return { jobs: out, errors };
}
