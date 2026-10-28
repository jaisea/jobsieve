import * as gemini from './gemini.js';

/**
 * PROVIDER LAYER
 *
 * Gemini, and nothing else.
 *
 * This used to hold three: Ollama first because a local model is free, then
 * Gemini, then Anthropic. In practice the chain was never used — `.env` carried
 * `LLM_PROVIDERS=gemini` and all 208 stored verdicts name a Gemini model. Two
 * files, a dependency and a fallback path existed to serve a case that never
 * happened. This is one person's tool, not a product, so the abstraction was
 * costing more than it bought.
 *
 * The contract stays, because it is what the runner talks to:
 *
 *   configured()  -> boolean          usable right now?
 *   describe()    -> string           what shows in logs and the report
 *   complete({system, user, schema})  -> { ok, data } | { ok:false, error, fatal }
 *
 * `fatal: true` still means "stop using this for the rest of the run" (bad key,
 * quota gone) rather than one failed posting. With a single provider that ends
 * adjudication instead of moving on — and search degrades to rules verdicts and
 * says so, which is what it always did when the last provider dropped out.
 */
export const PROVIDERS = { gemini };

/**
 * Resolve the provider chain.
 *
 * Kept as a chain-shaped return so the runner is unchanged: it still walks a
 * list, still reports unknown names, and still handles an empty list as "no
 * provider configured". The list is now at most one long.
 */
export function resolveChain(override) {
  // `??` not a default parameter: config/profile.json carries `providers: null`
  // to mean "defer to .env", and a default parameter only fires on `undefined`,
  // so `null` silently blanked the chain and LLM_PROVIDERS was ignored.
  const envValue = override ?? process.env.LLM_PROVIDERS;

  const requested = (envValue || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const chain = [];
  const unknown = [];

  // The switch is absolute: GEMINI_ENABLED=false parks the provider without
  // deleting the key, and must win over an explicit LLM_PROVIDERS naming it.
  const names = (requested.length ? requested : ['gemini'])
    .filter((n) => !PROVIDERS[n]?.enabled || PROVIDERS[n].enabled());

  for (const name of names) {
    const mod = PROVIDERS[name];
    if (!mod) { unknown.push(name); continue; }
    // An explicitly requested provider stays in the chain even if it looks
    // unconfigured, so the user gets a real error instead of silence.
    if (requested.length || mod.configured()) chain.push(mod);
  }

  const disabled = allProviders().filter((m) => m.enabled && !m.enabled());
  return { chain, unknown, disabled };
}

export const allProviders = () => Object.values(PROVIDERS);
