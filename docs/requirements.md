# jobsieve — product requirements

*Version 1.1 · 28 October 2026 · Single user, runs locally*

> A local job-search agent. It reads job adverts from many sources, decides which are worth one person's attention, remembers what it has already shown, and writes a tailored CV and cover letter for the ones that survive.

## 1. Why it exists

Searching for a role in a German-speaking region means checking LinkedIn, StepStone, XING and a dozen company career pages by hand. The same adverts come back every time. Nothing remembers what has already been read.

The tool is not written for one field. What counts as a match — the target titles, the search terms, the words that place a title in the candidate's field, the skills — is configuration. It ships with two example profiles, a full-stack web engineer and a DevOps / SRE / cloud engineer, and is tuned for the German market: a German-language requirement check, the federal employment agency, German job-alert senders and German compound titles are built in.

Three conditions of that market shape everything the tool does. All three are configuration, not assumptions built into the code.

- **Most local adverts are in German and ask for fluency.** For a candidate below that level, the results are almost entirely noise unless language is filtered.
- **But the filter cannot be a blunt cut.** A notice period pushes the realistic start date months out, and a language level recorded as rising. A role out of reach today may be reachable by the time anyone hires.
- **Existing work authorisation is an advantage, not a barrier.** Where the candidate already has the right to work, adverts anxious about visa sponsorship should score higher rather than be excluded.

## 2. Who it is for

One person, running it on their own machine. It is not a service, has no accounts, and stores nothing remotely. Every judgement it makes is calibrated to one profile.

This is a deliberate constraint. A tool for one person can hold strong opinions about what counts as a match. A tool for many cannot.

| At a glance | |
|---|---|
| Sources | 19 |
| Filter gates | 7 |
| Search radius | 70 km |
| Runtime | Node, no build |

## 3. The rule everything follows

> **A wrong keep costs a minute of reading. A wrong drop costs an opportunity that is never seen again.**
>
> So the rules may only decide when they are certain. Anything resting on a guess is passed to a language model to judge, rather than being deleted quietly.

Every posting ends in one of three states.

| Verdict | Meaning | What happens |
|---|---|---|
| Keep | The rules are sure it fits | Scored and shown |
| Drop | The rules are sure it does not | Filed with the reason, never shown |
| Uncertain | The rules cannot tell | Sent to a language model to decide |

A second rule follows from the first: **never state a fact about a posting that the posting does not support.** Where evidence is missing, the answer is "unknown" and the question is escalated. This applies to adverts and to the candidate's own history alike.

## 4. Finding jobs

- **F1** · Collect adverts from many sources in one run: open and remote job boards, company career boards, two keyed aggregators, the German federal employment agency, job-alert emails, recruiting agencies that post on behalf of a client they do not name, and corporate career sites that publish only a sitemap.
  - *Why:* LinkedIn, StepStone and XING have no public interface. They are reached indirectly through aggregators and through alert emails the user has set up.
- **F2** · Read job-alert emails over IMAP, covering a configurable recent window, without marking anything as read.
  - *Why:* The mailbox belongs to the user. The tool reads it and changes nothing.
- **F3** · Fetch the full advert for any posting that arrived truncated, and judge it again on the fuller text.
  - *Why:* One aggregator cuts every description at exactly 500 characters. Alert emails carry none at all. Without this, most decisions rest on text nobody has seen.
- **F4** · Where a site publishes no machine-readable advert, use whatever public page it does serve, at a polite request rate.
  - *Why:* Forty-four percent of stored jobs once had no description at all, every one from a LinkedIn alert. Recovering them changed the language verdict on sixteen.
- **F5** · Filter at the source where the API offers it. Today that means the country parameter on the two keyword aggregators, and a country facet on Workday boards. The published-board sources have no filter to use, so everything they list is fetched and judged locally.
  - *Why:* Global employers return thousands of irrelevant postings. One search of a large medical employer returned 63 results, of which 4 were in Germany. The saving is real only where the source is that lopsided, which is why this is not applied everywhere.
- **F6** · A failing source degrades the run and is reported. It never stops the run and never fails silently.
- **F7** · Re-read a stored advert after a set period, because adverts change after publication.
  - *Why:* One posting gained a "native German required" line hours after it was captured. Every later run judged the old copy.
- **F8** · Discard a posting that has stopped accepting applications, before any other question is asked.

## 5. Deciding

Seven checks run in order. The checks that read only the title run first, before any advert is fetched; the rest run on the full text. Every check runs and every reason is kept: the first certain failure owns the verdict, and an uncertain one is remembered, because a later check may settle the posting for free.

| Order | Check | Rejects when |
|---|---|---|
| 1 | Still open | The advert has closed, or the URL says it is not there |
| 2 | Excluded title | Junior, intern, apprentice and similar |
| 3 | Employment type | Part-time, or another type the profile excludes |
| 4 | Posting age | Older than the configured limit |
| 5 | Target role | Neither a target title nor in the candidate's field, or another specialisation |
| 6 | Location | Outside the radius, or remote but restricted elsewhere |
| 7 | German | Requires German beyond the candidate's level |

### Role

- **D21** · Decide whether a title belongs to the candidate's field from vocabulary in the profile — words that place a title in the field, specialisations that are clearly another track, and near-miss words — never from a list built into the code. With no vocabulary configured, the target titles alone decide.
  - *Why:* The vocabulary was once written into the code, which made the tool a tool for one kind of engineer: a full-stack developer's titles were "another specialisation" by definition. The field is the user's, not the tool's.
- **D22** · A title naming both the candidate's field and another specialisation is a question, not a verdict. A near-miss word counts only beside a role noun.
  - *Why:* Testing the other-track list first let one stray word drop sixteen right titles in a single fetch. And a field word merely somewhere in the title matched a sales role that happened to name the field.
- **D23** · Tell the model the candidate's field in the candidate's own words, from configuration, and never assume one.

### Language

- **D1** · Grade the German requirement into four levels — none, basic, conversational, required — plus "unknown" when the advert cannot be read.
- **D2** · Never claim a level the advert did not state. Where a range is given, take the higher end.
  - *Why:* "German B2/C1" was read as B2. What matters is the level the interview will test.
- **D3** · Do not let a level stated for another language be read as German.
  - *Why:* "English C1, German B2" was graded German C1. That is a wrong drop, the expensive kind.
- **D4** · Recognise a plain requirement with no level named — "German is a must", "Deutschkenntnisse erforderlich" — and equally recognise a plain denial: "no German required".
- **D5** · Distinguish the language as a subject from the country as a place. "Must be based in Germany" is a location rule, not a language rule.
- **D6** · An advert written entirely in German with no English signal implies a requirement, but that is an inference, so it is escalated rather than decided.
- **D7** · Raising the recorded German level automatically promotes roles that were previously out of reach, with no change to the rules.
  - *Why:* The tool should track the candidate's progress, not need rewriting after each exam.

### Location

- **D8** · Accept onsite and hybrid roles within a configurable radius, measured from the home city using a built-in place list. No external geocoding service.
- **D9** · Accept remote roles that are open to Germany, the EU, or worldwide. Reject those restricted to another country.
- **D11** · Believe the advert over the aggregator's own tags.
  - *Why:* One aggregator labelled a job "remote" when its text offered only "the possibility of home office". The job was 505 km away and reached the top of the report.

### When the advert never arrived

- **D18** · A posting whose advert was asked for and did not arrive is HELD, not judged. It is kept out of the results, listed plainly, and tried again next run.
  - *Why:* With no text, every check reports an absence: no language requirement, no tools named, no mention of where the work happens — findings drawn from nothing. One role reached the report at 70/100 that way, and its advert demanded negotiation-level German. An empty advert is not a missing requirement.
- **D19** · Holding means the advert was asked for and did not arrive — never that nothing looked. A run that skips fetching, or re-judges a stored fetch, must neither hold a posting nor release one it finds held.
  - *Why:* Both halves were got wrong in turn. Holding on liveness alone kept four hundred postings back on the one flag whose purpose is to skip the network; and re-judging a stored fetch released everything still waiting, so two postings refused by a rate limit were judged with nothing read and turned down by hand — one of them as closed, which nobody could have known without the advert.
- **D20** · Give up eventually. After repeated tries the failure has stopped being temporary, and the posting is judged on whatever the sources gave.

### Escalating to a language model

- **D12** · Ask only about the specific things the rules could not settle, one question each, with the evidence attached.
- **D13** · Tell the model plainly what has already been settled, so it cannot overturn a fact it was not asked about.
  - *Why:* Asked about language, the model began rejecting jobs on location instead. Four of six disagreements were that one error.
- **D14** · Never present an absence of evidence as a settled fact. If a check found nothing but the advert plainly discusses the subject, ask rather than assert.
  - *Why:* A blind spot in the rules was invisible to the model, because the model had been told the matter was closed.
- **D14a** · The escape hatch has to soften the CHECK, not merely add a question. A check that is certain settles the posting before any question is read.
  - *Why:* Written as a question alone it had no effect at all, and the measurement said so: the posting was already discarded on distance by the time the questions were looked at. This is structural rather than a bug, so it is worth stating as a requirement — the same escape hatch will be wanted for a third subject one day.
- **D14b** · Ask only when the advert genuinely raises the subject and the rules genuinely could not settle it. A posting the employer answered plainly in their own words is not a case the rules failed.
  - *Why:* Where the work happens is the second subject to need this, after language. Two roles offering full-time home office were discarded hundreds of kilometres away because a hedging word sat beside the claim. But counting the employer's own word for an arrangement as "unsettled" doubled the cost for nothing: half the postings it caught named no home working at all and were simply hybrid, which is what the advert said. Widening a pattern fixes the phrasing already seen; asking fixes the next one.
- **D15** · Cache every answer. Change the question and the cache is invalidated, so old answers cannot mix with new reasoning. The question includes the facts stated about the candidate, so editing the language level, the travel radius or the target titles clears the cache too.
  - *Why:* Raising the language level after an exam re-opened every posting the rules had dropped, while every posting the model had dropped stayed dropped, on reasoning that no longer applied.
- **D17** · Never ask again about a posting the user has already closed. Refreshing verdicts must not put a job the user has applied to, turned down or hidden back in front of them.
  - *Why:* Rejections are re-judged on every run on purpose, so that editing a rule takes effect. Once the user has answered for themselves, that answer stands.
- **D16** · A missing key or a broken provider degrades the run to rules verdicts, labelled as such, rather than stopping it. A rate limit is different: a posting the model could not answer waits for the limit to lift, and is never decided by the rules that were unsure about it.

### Scoring

Surviving postings are scored out of 100 and banded. The weights are configuration, not code.

| Component | Max | Based on |
|---|---|---|
| Title match | 40 | How closely the title matches the target roles |
| Skill overlap | 30 | Technologies in the advert against the candidate's own list |
| Location fit | 20 | Distance, or the reach of a remote role |
| Freshness | 10 | Full marks for a week, falling to zero at a month |

## 6. Remembering

- **M1** · Show a posting once. A second run reports only what is new.
  - *Why:* This is the core of the tool. Running it twice in a row must report zero new jobs.
- **M2** · Recognise the same job arriving from two sources as one job, allowing for the decorations German adverts add to titles.
- **M3** · Give a posting a permanent identity that never changes, even when a fuller description later changes what is known about it.
- **M4** · Keep rejected postings in a separate store from the "already shown" record.
  - *Why:* Otherwise, fixing a rule cannot bring back the jobs it wrongly rejected. Rejections must be re-judged on every run.
- **M5** · Keep the full text of every advert, so a posting survives being taken down.
- **M6** · Track status: new, shown, interested, applied, not for me, hidden. Applied and rejected leave the queue.
- **M7** · Write state to disk in a way that cannot be left half-written if the run is interrupted.
  - *Why:* Losing the memory file means the next run reports several thousand jobs as new.

## 7. Presenting the results

- **P1** · Produce a single self-contained web page with no external requests, readable offline.
- **P2** · Show each job with its score and how the score was reached, the matched skills, the risks, the source, and a link to apply.
- **P3** · State plainly when a judgement rests on a partial advert, rather than presenting it with the same confidence as a full one.
- **P4** · List rejected postings at the foot of the page, grouped by the reason, so the filter itself can be reviewed.
- **P5** · Allow a whole group of rejections to be marked as reviewed, so later runs show only what is new.
- **P6** · Offer an optional local server so the buttons write directly to the record. Opened as a plain file, the same buttons copy the equivalent command instead of failing quietly.
- **P7** · Explain, for any single posting, exactly which check rejected it and why — from the same definitions the run itself used.
  - *Why:* An explanation that can disagree with the pipeline is worthless.
- **P8** · Deciding and displaying are separate jobs. The page shows a stored decision; it never makes one.
  - *Why:* When both commands could decide, the same posting was present or absent depending on which had run last.

## 8. Applying

For a posting worth applying to, the tool produces a tailored CV and cover letter as PDFs, saved for review. It never sends anything.

- **A1** · Edit the candidate's real CV in place, changing only the lines worth changing — at most ten. Keep the layout, the fonts and the bullet formatting exactly as they are.
  - *Why:* This is keyword emphasis, not a new CV. The document must still look like the one the candidate wrote.
- **A2** · Never change the opening summary line's job title, and never replace a strong verb with a weaker one. The title is checked in code and stops the PDF; the verb is an instruction only.
  - *Why:* One draft re-titled the candidate to match the advert and traded "designing and operating" for "administering" — a demotion on the most-read line of the CV. The instruction forbade both in three sentences and the model did it anyway, so the half that is a fixed string is now verified the same way an invented number is. The verb cannot be checked that way and is caught by reading the diff, which the user does on every run.
- **A3** · Write the cover letter in the candidate's own voice, using their real past letters as examples, always in English.
- **A4** · Show every rewritten line as a before-and-after comparison, word by word, before anything is written to disk.
  - *Why:* The overstatements hide in a single word. One draft swapped a provable specialisation for a vaguer, broader claim in an otherwise identical sentence.
- **A5** · Check every claim against the candidate's recorded history before producing a PDF. An invented number stops the PDF. An unrecognised technology is reported but does not.
  - *Why:* The number check has never been wrong. The technology check spent a day rejecting the candidate's own tools.
- **A6** · When a check fails, ask the model once to say the same thing in words it is allowed, rather than stopping.
- **A7** · Review the finished draft with a separate, sceptical pass that has seen both the candidate's history and the original CV lines.
  - *Why:* Judging the draft against the history alone, it called the candidate's own CV wording unsupported.
- **A8** · Keep everything: what was sent, what came back, what was flagged, and a frozen copy of the generated text.
  - *Why:* Once the document is edited by hand, there is otherwise nothing left to compare the corrections against.
- **A9** · Record each edit together with the line it replaced, so the change can be reviewed weeks later without regenerating anything.
- **A10** · Marking a job as applied keeps a copy of the advert, whether or not anything was tailored.
  - *Why:* The advert is the part that disappears. It is the only record of what was actually responded to.
- **A11** · Learn from corrections, but only apply a style rule after the same correction has been made three times.
  - *Why:* One edit is a preference. Treating each as a rule produces a set of contradictory instructions.
- **A12** · Record what was asked for, at the moment it is known. It is free text, it is optional, and it is never cleared by a later change of status.
  - *Why:* The figure is typed into the employer's form and then exists in no other artefact — not the advert, not the CV, not the letter. Months later, when an offer arrives, it is the one fact nothing else kept. A figure plus a bonus, a range and "declined to state" are all real answers, so parsing it into a number throws away the half that matters; refusing to mark a job applied without one would simply stop jobs being marked. A reject reason describes the current verdict and goes stale — what was asked for happened.
- **A13** · Offer the usual figure already filled in, from configuration, selected so that typing replaces it. With nothing configured, offer an empty box.
  - *Why:* The answer is the same on almost every application. A default that has to be cleared first costs time on every posting where it is wrong, and a default that silently became the answer would be worse than none — the figure only matters because it is the one thing nothing else remembers.
- **A14** · Group applications by where they stand: ones progressing, ones still in play, and ones folded away. Nothing is deleted — a folded application still opens, and promoting it moves it straight back out.
- **A15** · Answer silence with age. An application not promoted within thirty days is folded away. There is no "rejected" status.
  - *Why:* Age already answers it: an application nobody promoted, a month old, is finished whether the refusal arrived in writing or never came at all, and the distinction changes nothing the candidate would do next. Six statuses were offered, every one chosen by hand weeks after the fact, and across sixty-one applications exactly one had ever been set. Chasing the written refusal — which was built, and removed before it shipped — is machinery for a distinction with no consequence. Something in progress never folds, however old it is.

## 9. Learning from decisions

- **L1** · When a job is marked "not for me", ask why, and record the answer in a vocabulary the checks can be compared against.
  - *Why:* Working this out from the adverts afterwards does not succeed — see L2 — so the answer has to be given at the time.
- **L1a** · Offer a small number of plain choices, each standing for one or more checks, rather than one button per check.
  - *Why:* Eleven buttons asked the user to decide which detector to blame. Choosing between "programming required", "AWS-centric" and "does not name your tools" — checks that existed then and have since been removed — was the checks' own filing, and the honest answer at the moment of clicking is usually that the skills do not line up. Six choices ask what the user actually knows. The checks themselves are unchanged: merging them would re-open thousands of already-reviewed rejections, and comparing at the group level instead of the check level was measured over every answered rejection and moved none of them between "already flagged" and "missed".
- **L1b** · A choice the user has never had a reason to pick gets no button. A posting dropped for being too old or scoring too low was already discarded by that check, so one reaching the review is one that check did not catch.
- **L2** · Keep every reason a posting failed, not only the first, so a hand rejection can be compared against all of them: a rejection is "already flagged" if ANY check gave that reason, not just the one that got there first.
  - *Why:* Working this out from the adverts afterwards does not succeed. Of 34 rejections assumed to be about language, 19 never mentioned language at all; and comparing only against the first check made most apparent misses look like misses when another check had already said the same thing.
- **L3** · Record how often each check fires, per source, and say so when a share moves sharply between runs, so a check that silently changed behaviour is noticed.
- **L4** · Track which employers are covered by a working board, which are covered only by an email alert, and which are not covered at all.

## 10. Configuration and privacy

- **C1** · Every rule, weight and threshold is read from configuration at run time. Changing behaviour should not mean changing code.
- **C2** · Personal details live in configuration only, never in source files. The code is public; the configuration is not.
- **C3** · Credentials live in one file, separate from the profile, and never leave the machine.
- **C4** · Send a language model only what it needs. Name, contact details and client names are withheld.
  - *Why:* Who someone worked for is a different disclosure from what they did, and some of it is under agreement.
- **C5** · Record what the candidate has *not* done as well as what they have. A list of things not used must never be readable as permission to claim them.
- **C6** · Report when the recorded history contradicts itself, rather than resolving it silently in one direction.
- **C7** · Allow a more capable Gemini model for writing than for filtering. One provider is supported, deliberately.
  - *Why:* Filtering is tens of calls per search — the last five runs asked 0, 9, 69, 76 and 149 times, because the number is whatever the rules could not settle — and it decides what gets read. Writing is two or three per application and is what an employer sees. Three providers were supported at one point and only ever one was used, so the other two were removed rather than kept working for a case that does not arise.

## 11. How it runs

| Constraint | Decision |
|---|---|
| Platform | Node 22 or later. No build step, no bundler, no framework. |
| Dependencies | Two, both for reading email. Everything else uses what the runtime provides. |
| Storage | Plain files on disk. No database. |
| Documents | Word, driven locally, because the CV template is a real Word file and its layout must survive. |
| Schedule | Run by hand, or by an optional tray app that fetches each source on its own interval. Nothing runs anywhere but the user's machine. |
| Cost | Free tiers only. A single search stays inside the daily limits. |
| Tests | Each test states the behaviour it protects and why, not the function it calls. |
| Iterating | Changing a rule must not cost a fetch. The last run is stored before any judgement is applied to it, so a rule can be re-run against the same postings offline, repeatedly, with no network and no spend. |

## 12. Running in the background

An optional desktop app keeps looking for new jobs without being asked, and shows how many are waiting. It holds no decisions of its own: what is due, what the count is and when to look next are the same plain functions the command line uses.

- **B1** · Look every half hour, and fetch each source only when its own rest interval is over. A source with no interval set rests six hours; mail is cheap and time-sensitive, so it rests half an hour; a source with a monthly budget rests a day. The interval and the quota compose: a source can be due and still be refused for a spent budget.
  - *Why:* The look is not the fetch rate. Fetching everything every half hour would spend a month's metered allowance in days and ask every board forty-eight times a day for the same postings.
- **B2** · Record a source as fetched only once its results are safely on disk. A scan cut off part way leaves the unfinished sources due at the next look.
  - *Why:* Recording at the moment of the request meant a scan stopped by closing the lid left its sources asleep for hours — a day for the metered one — over results that were never saved.
- **B3** · Show the number of open jobs — everything not yet applied for or turned down, interested ones included — on the tray icon, as a badge on the taskbar button and in the window title. Mark a failed scan visibly.
  - *Why:* Interested jobs were once counted apart, so one interested job and nothing else meant no badge at all, which read as the feature not working.
- **B4** · Compute "open" from the stored data every time, with one definition shared by the tray, the badge, the title, the page and the search itself.
  - *Why:* A saved list of what the last report showed went stale the moment anything changed without a new report; restoring a turned-down job made it open in the data and missing from the app.
- **B5** · Show the report in the app's own window, loaded from the same local server the command line starts. Nothing is rendered by the app itself.
- **B6** · Closing the window hides it and scanning carries on. Only Quit, or the system shutting down, ends the app. Only one copy runs at a time.
- **B7** · Announce new jobs while a scan is still running: one notice for the first, then at most one a minute, each saying how many more. The end of the scan announces only what is left, and a quiet scan says nothing. Notices can be switched off.
  - *Why:* A scan lands one source after another. Announcing each would be a stream of notices; waiting for the end would make the quick sources' finds wait for the slowest.
- **B8** · Never reload the page the user is working on. The page fetches what has changed and adds or retires cards in place.
  - *Why:* A reload loses a half-chosen reason or a typed filter.
- **B9** · Offer scan now, pause, start with Windows and quit from both the tray menu and the page, through one implementation of each, with the same status text in both places. Where there is no app — the report served from the command line — hide the controls rather than show buttons that do nothing.
- **B10** · With no internet connection, a scan is not attempted and nothing is recorded: no source is marked as tried, no retry is scheduled, no quota is charged. Wait, check again every twenty seconds, and scan the moment a connection returns. Decide "offline" by asking two independent web servers, not the network adapter.
  - *Why:* A scan started before the connection was back after sleep marked every source as failed, and charged the metered ones a run for requests that never left the machine — one early scan could cost a day's allowance. A network adapter reports "connected" to a router with no uplink.
- **B11** · Allow one search at a time, whether started by the app or typed in a terminal. A lock left by a process that has died is not a lock. A dry run, which writes nothing, takes no lock.
  - *Why:* Both read the memory at the start and write it at the end, so the later one would discard the other's finds and any status set in between.
- **B12** · Only the local server's own address loads in the app's window. Any other web address opens in the user's browser; anything else — local files, scripts, data addresses — is refused.
  - *Why:* The report is built from text that job boards wrote. A link in an advert must never run inside the app.
- **B13** · Run every window sandboxed and isolated from the app's own code, with no access to the machine, and refuse every permission a page asks for.
- **B14** · Accept a change only from the app's own page. The local server refuses a write sent by any other web page.
  - *Why:* Binding to the local address keeps other machines out, not other websites: any page open in the browser can send a request to a local port, and could otherwise quit the app, start a scan or mark jobs applied.
- **B15** · When the language model's limit is reached, show how many postings are waiting and when the limit lifts, and wake for that moment to judge them rather than waiting for the next look.
- **B16** · Keep one log for the terminal and the app, shown in the app, including the live output of a scan in progress.
  - *Why:* Without the live output a ten-minute scan would show nothing for ten minutes.
- **B17** · The app is optional. Quitting it leaves nothing running, and every command works the same without it.

## 13. Not in scope

- Submitting applications. The tool prepares documents; a person sends them.
- Signing in to any job site, or acting on the user's behalf on one.
- Running on a server, or for anyone other than the person whose profile it holds.
- Judging the candidate. It filters adverts, it does not rank the person against them.
- Storing anything outside the user's own machine.

## 14. How success is measured

- **V1** · Two runs in a row: the second reports zero new jobs.
- **V2** · The same posting appearing from two sources collapses into one entry that names both.
- **V3** · A stated fluency requirement is rejected. A "German is a plus" advert is not.
- **V4** · A remote role restricted to another country is rejected. A remote role open to Germany is not.
- **V5** · Fixing a rule and running again brings back the jobs that rule had wrongly rejected, with nothing to un-hide by hand.
- **V6** · A generated CV names no technology the candidate has not used, and no number they cannot evidence.
- **V7** · The explanation given for a single posting matches what the run actually did.
- **V8** · A dead source, a spent quota or a missing key is visible in the output, not silent.

## 15. Known limits

- Three large job sites have no public interface. They are reached only through aggregators and email alerts, so coverage of them is partial.
- One aggregator lists jobs several weeks after they are posted. The age limit is set generously because of it.
- About half of closed postings still serve a full advert with no marker of any kind, and cannot be detected as closed.
- One large employer's board cannot be filtered by country and is fetched in full.
- The candidate's recorded history is not in version control, so it has no backup.

---

*jobsieve — product requirements, version 1.1. Written from the working tool and the decisions behind it.*
