import * as arbeitnow from './arbeitnow.js';
import * as remotive from './remotive.js';
import * as remoteok from './remoteok.js';
import * as ats from './ats.js';
import * as workday from './workday.js';
import * as adzuna from './adzuna.js';
import * as jsearch from './jsearch.js';
import * as arbeitsagentur from './arbeitsagentur.js';
import * as mailalerts from './mailalerts.js';
import * as agencies from './agencies.js';
import * as careersites from './careersites.js';
import * as getro from './getro.js';
import * as personio from './personio.js';
import * as teamtailor from './teamtailor.js';
import * as germantechjobs from './germantechjobs.js';
import * as beesite from './beesite.js';
import * as himalayas from './himalayas.js';
import * as jobicy from './jobicy.js';
import * as bwi from './bwi.js';

export const SOURCES = { arbeitnow, remotive, remoteok, ats, workday, adzuna, jsearch, arbeitsagentur, mailalerts, agencies, careersites, getro, personio, teamtailor, germantechjobs, beesite, himalayas, jobicy, bwi };

/** Sources whose ToS require a visible credit in the report. */
export function attributions(usedSourceIds) {
  return Object.values(SOURCES)
    .filter((s) => s.attribution && usedSourceIds.has(s.id))
    .map((s) => s.attribution);
}
