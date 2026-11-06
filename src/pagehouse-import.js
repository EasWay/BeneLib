import crypto from 'node:crypto';

const SOURCES = [
  ['libgen', 'Library Genesis'],
  ['archive', 'Internet Archive'],
  ['gutenberg', 'Project Gutenberg'],
  ['openstax', 'OpenStax'],
  ['libretexts', 'LibreTexts'],
  ['memoryoftheworld', 'Memory of the World'],
  ['royallib', 'RoyalLib'],
  ['zlibrary', 'Z-Library'],
  ['annas', "Anna's Archive"],
  ['mobilism', 'Mobilism'],
];

const QUERIES = [
  'introduction', 'beginner guide', 'complete guide', 'textbook', 'handbook', 'reference',
  'history', 'world history', 'ancient history', 'modern history', 'biography', 'memoir',
  'science', 'biology', 'chemistry', 'physics', 'astronomy', 'geology', 'environment',
  'mathematics', 'algebra', 'calculus', 'statistics', 'computer science', 'engineering',
  'medicine', 'anatomy', 'psychology', 'neuroscience', 'health', 'nutrition',
  'economics', 'business', 'accounting', 'management', 'entrepreneurship', 'finance',
  'sociology', 'anthropology', 'political science', 'law', 'education', 'philosophy',
  'literature', 'classic novel', 'poetry', 'short stories', 'drama', 'mythology',
  'language learning', 'writing', 'art', 'architecture', 'music', 'design', 'cooking',
  'agriculture', 'parenting', 'travel', 'religion', 'technology', 'climate change',
  'social science', 'public policy', 'leadership', 'personal development',
];

const MAX_LIMIT = 5000;
const MAX_BATCH = 500;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeUrl = value => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};

let activeRun = null;
let lastRun = null;

export function getCatalogImportStatus() {
  return activeRun || lastRun || { status: 'idle' };
}

export function startCatalogImport({ search, importBatch, disabledSources = [], limit = MAX_LIMIT } = {}) {
  if (typeof search !== 'function' || typeof importBatch !== 'function') throw new Error('Search and catalog import functions are required');
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_LIMIT) throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  if (activeRun) return { ...activeRun, reused: true };

  const disabled = new Set(disabledSources);
  const enabled = SOURCES.filter(([id]) => !disabled.has(id));
  if (!enabled.length) throw new Error('All e-book sources are switched off');
  const now = new Date();
  const offset = crypto.randomInt(QUERIES.length);
  const queries = [...QUERIES.slice(offset), ...QUERIES.slice(0, offset)];
  const run = {
    id: crypto.randomUUID(),
    status: 'running',
    startedAt: now.toISOString(),
    finishedAt: null,
    limit: cap,
    sources: enabled.map(([id]) => id),
    queries: 0,
    searched: 0,
    received: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: [],
  };
  activeRun = run;
  lastRun = run;

  void (async () => {
    let batch = [];
    const seen = new Set();
    const flush = async () => {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      const result = await importBatch(current);
      run.inserted += result.inserted;
      run.updated += result.updated;
      run.unchanged += result.unchanged;
    };

    try {
      for (const query of queries) {
        run.queries++;
        const results = await Promise.all(enabled.map(async ([sourceId, sourceName]) => {
          try {
            run.searched++;
            const values = await search(sourceId, query);
            return { sourceId, sourceName, values: Array.isArray(values) ? values : [] };
          } catch (error) {
            if (run.errors.length < 50) run.errors.push({ source: sourceId, query, message: String(error.message || error).slice(0, 300) });
            return { sourceId, sourceName, values: [] };
          }
        }));
        for (const { sourceId, sourceName, values } of results) {
          for (const item of values) {
            const title = String(item?.title || '').trim();
            if (!title) continue;
            const pageUrl = safeUrl(item.pageUrl || item.detailUrl || item.topicUrl || item.downloadUrl);
            const sourceRef = pageUrl || `search:${crypto.createHash('sha256').update(`${title}\0${item.author || item.authors || ''}`).digest('hex')}`;
            const key = `${sourceId}\0${sourceRef}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (run.received >= cap) break;
            const year = Number.parseInt(item.year, 10);
            batch.push({
              sourceId,
              sourceRef,
              sourceName,
              title,
              authors: String(item.author || item.authors || '').trim(),
              description: String(item.description || '').trim(),
              language: String(item.language || '').trim(),
              publishedYear: Number.isInteger(year) && year >= 0 && year <= 2200 ? year : null,
              format: String(item.format || '').replace(/^\./, '').toLowerCase(),
              subjects: Array.isArray(item.subjects) ? item.subjects : [],
              coverUrl: safeUrl(item.coverUrl || item.cover_url || item.cover || ''),
              rightsStatus: 'pending',
              license: String(item.license || '').trim(),
              rightsScope: String(item.rightsScope || '').trim(),
              rightsEvidence: String(item.rightsEvidence || '').trim(),
              attribution: String(item.attribution || '').trim(),
              priceMinor: 0,
              currency: 'GHS',
              fileStatus: 'metadata_only',
              status: 'listed',
            });
            run.received++;
            if (batch.length >= MAX_BATCH) await flush();
          }
        }
        run.updatedAt = new Date().toISOString();
        if (run.received >= cap) break;
        await pause(150);
      }
      await flush();
      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
    } catch (error) {
      run.status = 'failed';
      run.error = String(error.message || error).slice(0, 500);
      run.finishedAt = new Date().toISOString();
    } finally {
      activeRun = null;
      lastRun = { ...run, sources: [...run.sources], errors: [...run.errors] };
    }
  })();

  return { ...run, reused: false };
}
