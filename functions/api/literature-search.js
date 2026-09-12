function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

async function searchSemanticScholar(query) {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/search?' + new URLSearchParams({
    query,
    limit: '8',
    fields: 'title,authors,year,venue,externalIds,url,abstract,citationCount'
  });
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) {
    const err = new Error(`Semantic Scholar API error (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  return (data.data || []).map(p => ({
    title: p.title || 'Untitled',
    authors: (p.authors || []).map(a => a.name).slice(0, 5).join(', ') || 'Unknown authors',
    year: p.year || null,
    venue: p.venue || null,
    doi: p.externalIds?.DOI || null,
    url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null),
    abstract: p.abstract ? (p.abstract.length > 280 ? p.abstract.slice(0, 280) + '…' : p.abstract) : null,
    citationCount: typeof p.citationCount === 'number' ? p.citationCount : null
  })).filter(p => p.url);
}

async function searchCrossRef(query) {
  const url = 'https://api.crossref.org/works?' + new URLSearchParams({ query, rows: '8' });
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) {
    const err = new Error(`CrossRef API error (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const items = data.message?.items || [];
  return items.map(it => ({
    title: (it.title && it.title[0]) || 'Untitled',
    authors: (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).slice(0, 5).join(', ') || 'Unknown authors',
    year: it['published-print']?.['date-parts']?.[0]?.[0]
      || it['published-online']?.['date-parts']?.[0]?.[0]
      || it.created?.['date-parts']?.[0]?.[0] || null,
    venue: (it['container-title'] && it['container-title'][0]) || null,
    doi: it.DOI || null,
    url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : null),
    abstract: null,
    citationCount: typeof it['is-referenced-by-count'] === 'number' ? it['is-referenced-by-count'] : null
  })).filter(p => p.url);
}

export async function onRequestPost(context) {
  try {
    const accessCode = context.env.ACCESS_CODE;
    if (accessCode) {
      const provided = context.request.headers.get('X-PVLab-Access') || '';
      if (provided !== accessCode) {
        return jsonResponse({ error: 'Invalid or missing access code' }, 401);
      }
    }

    const { query } = await context.request.json();
    if (!query || typeof query !== 'string' || !query.trim()) {
      return jsonResponse({ error: 'query is required' }, 400);
    }
    const q = query.trim();

    let results, source;
    try {
      results = await searchSemanticScholar(q);
      source = 'Semantic Scholar';
    } catch (e1) {
      try {
        results = await searchCrossRef(q);
        source = 'CrossRef';
      } catch (e2) {
        return jsonResponse({
          error: 'Both literature search sources are temporarily unavailable (rate limited). Please wait a minute and try again.'
        }, 503);
      }
    }

    return jsonResponse({ results, query: q, source });
  } catch (err) {
    return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
  }
}
