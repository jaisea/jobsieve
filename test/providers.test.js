/**
 * Provider resolution.
 *
 * There used to be three providers — Ollama first because a local model is
 * free, then Gemini, then Anthropic — and these tests pinned the ordering and
 * fallback rules. The chain was never used: `.env` carried
 * `LLM_PROVIDERS=gemini` and all 208 stored verdicts name a Gemini model. Two
 * provider files, an SDK dependency and a fallback path served a case that
 * never happened, so they are gone.
 *
 * What still needs pinning is what happens at the edges: no key, the provider
 * parked, and an old `.env` still naming a provider that no longer exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { resolveChain, PROVIDERS } from '../src/providers/index.js';

/** resolveChain reads process.env, so each case runs with a clean slate. */
function withEnv(vars, fn) {
  const saved = {};
  const keys = ['LLM_PROVIDERS', 'GEMINI_API_KEY_JUDGE', 'GEMINI_ENABLED'];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const ids = (chain) => chain.map((c) => c.id);

test('the provider implements the contract the runner expects', () => {
  for (const [name, mod] of Object.entries(PROVIDERS)) {
    assert.equal(typeof mod.configured, 'function', `${name}.configured`);
    assert.equal(typeof mod.describe, 'function', `${name}.describe`);
    assert.equal(typeof mod.complete, 'function', `${name}.complete`);
    assert.equal(typeof mod.id, 'string', `${name}.id`);
  }
});

test('only Gemini ships — no orphan provider files are left behind', () => {
  // Deleting a provider means deleting its file. One left in place still
  // imports its SDK and reads its key, which is the kind of thing that is only
  // noticed when npm audit flags a dependency nothing uses.
  const files = readdirSync(p('src', 'providers')).sort();
  assert.deepEqual(files, ['gemini.js', 'index.js']);
  assert.deepEqual(Object.keys(PROVIDERS), ['gemini']);
});

test('a key alone is enough to turn adjudication on', () => {
  withEnv({ GEMINI_API_KEY_JUDGE: 'x' }, () => {
    assert.deepEqual(ids(resolveChain().chain), ['gemini']);
  });
});

test('no key means an empty chain, not a crash', () => {
  // Search then falls back to rules verdicts and says so in the report. This is
  // the path every run takes before a key is set, so it must be quiet.
  withEnv({}, () => {
    const { chain, unknown } = resolveChain();
    assert.deepEqual(chain, []);
    assert.deepEqual(unknown, []);
  });
});

test('an explicitly requested provider stays in the chain even if unconfigured', () => {
  // So a missing key produces a real error from the provider rather than the
  // silence of an empty chain.
  withEnv({ LLM_PROVIDERS: 'gemini' }, () => {
    assert.deepEqual(ids(resolveChain().chain), ['gemini']);
  });
});

test('an .env naming a removed provider says so instead of failing quietly', () => {
  // The migration case: LLM_PROVIDERS=ollama,gemini was a working config until
  // the providers were removed. It must name what it could not find.
  withEnv({ LLM_PROVIDERS: 'ollama,gemini' }, () => {
    const { chain, unknown } = resolveChain();
    assert.deepEqual(ids(chain), ['gemini'], 'the surviving name still works');
    assert.deepEqual(unknown, ['ollama'], 'and the dead one is reported');
  });
});

test('config can override the env chain', () => {
  withEnv({ LLM_PROVIDERS: 'gemini' }, () => {
    assert.deepEqual(ids(resolveChain('').chain), [], 'an empty override means none');
  });
});

test('a null config override defers to LLM_PROVIDERS, not to nothing', () => {
  // profile.json carries `providers: null` to mean "use .env". A default
  // parameter only fires on undefined, so null silently blanked the chain.
  withEnv({ LLM_PROVIDERS: 'gemini' }, () => {
    assert.deepEqual(ids(resolveChain(null).chain), ['gemini']);
  });
});

test('the switch parks the provider without deleting the key', () => {
  // GEMINI_ENABLED=false must win even when LLM_PROVIDERS names it, and the
  // provider must be reported as disabled rather than vanishing — `npm run
  // keys` prints that line so the reason is visible.
  withEnv({ LLM_PROVIDERS: 'gemini', GEMINI_API_KEY_JUDGE: 'x', GEMINI_ENABLED: 'false' }, () => {
    const { chain, disabled } = resolveChain();
    assert.deepEqual(chain, []);
    assert.deepEqual(ids(disabled), ['gemini']);
  });
});

test('the switch accepts the obvious falsey spellings', () => {
  for (const v of ['false', '0', 'no', 'off', 'FALSE', ' off ']) {
    withEnv({ GEMINI_API_KEY_JUDGE: 'x', GEMINI_ENABLED: v }, () => {
      assert.deepEqual(resolveChain().chain, [], `GEMINI_ENABLED=${v} should switch it off`);
    });
  }
  for (const v of ['true', '1', 'yes', '']) {
    withEnv({ GEMINI_API_KEY_JUDGE: 'x', GEMINI_ENABLED: v }, () => {
      assert.deepEqual(ids(resolveChain().chain), ['gemini'], `GEMINI_ENABLED=${v} should leave it on`);
    });
  }
});

test('nothing tells the user to install a provider that was removed', () => {
  // Deleting the provider files left three places still naming Ollama, two of
  // them error messages the user actually reads: "set GEMINI_API_KEY_JUDGE, or run
  // Ollama" and a `npm run keys` hint pointing at ollama.com/download. Both
  // would send someone to install support that no longer exists, at exactly the
  // moment they are already stuck.
  const files = ['src/adjudicate.js', 'src/apply/tailor.js', 'src/index.js',
    'src/apply/index.js', 'src/report.js', 'src/serve.js'];
  for (const f of files) {
    const src = readFileSync(p(f), 'utf8');
    assert.ok(!/ollama/i.test(src), `${f} still mentions Ollama`);
    assert.ok(!/anthropic/i.test(src), `${f} still mentions Anthropic`);
  }
});

test('the "no provider" errors name the one provider there is', () => {
  // Both paths are hit when the key is missing, which is the most common first
  // run. They have to say what to actually do.
  const adj = readFileSync(p('src', 'adjudicate.js'), 'utf8');
  const tailor = readFileSync(p('src', 'apply', 'tailor.js'), 'utf8');
  assert.match(adj, /No LLM provider configured[^']*GEMINI_API_KEY_JUDGE/);
  assert.match(tailor, /no LLM provider configured[^']*GEMINI_API_KEY_JUDGE/);
  // apply has no rules fallback, and the message must keep saying so.
  assert.match(tailor, /no rules fallback/);
});

test('the Gemini concurrency cap is a free-tier default, not a hard limit', () => {
  // It was hardcoded to 1 with the note "free-tier Gemini is ~10 requests per
  // minute". True when written, and it stopped being true the moment billing
  // was enabled — but a constant cannot notice that. Worse, it silently
  // overrode `llm.concurrency: 4` in profile.json, so the config said one thing
  // and the run did another.
  //
  // Measured on the paid tier, same key and model: 20 calls took 5.4s at
  // concurrency 4 and 3.1s at 8, with no errors at either. Serially the same
  // calls run at about 1144ms each.
  const src = readFileSync(p('src', 'providers', 'gemini.js'), 'utf8');
  assert.match(src, /GEMINI_MAX_CONCURRENCY/, 'must be settable');
  assert.match(src, /Math\.max\(1, Number\(judgeEnv\('GEMINI_MAX_CONCURRENCY'\)\) \|\| 1\)/,
    'and default to 1, which is right for the free tier');
});

test('the cap message names the lever rather than sounding like an API limit', () => {
  // "concurrency capped at 1 by Gemini" reads as something the API imposes.
  // It is a default, and one line of .env lifts it.
  const src = readFileSync(p('src', 'adjudicate.js'), 'utf8');
  assert.match(src, /set GEMINI_MAX_CONCURRENCY_JUDGE in \.env if you are paying/);
  assert.match(src, /!\(process\.env\.GEMINI_MAX_CONCURRENCY_JUDGE\)/,
    'and only says so when the default is what is capping it');
});
