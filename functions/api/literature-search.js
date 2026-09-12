function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
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

    const url = 'https://api.semanticscholar.org/graph/v1/paper/search?' + new URLSearchParams({
      query: query.trim(),
      limit: '8',
      fields: 'title,authors,year,venue,externalIds,url,abstract,citationCount'
    });

    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: `Semantic Scholar API error (${resp.status})`, detail: errText.slice(0, 300) }, resp.status === 429 ? 429 : 502);
    }

    const data = await resp.json();
    const results = (data.data || []).map(p => ({
      title: p.title || 'Untitled',
      authors: (p.authors || []).map(a => a.name).slice(0, 5).join(', ') || 'Unknown authors',
      year: p.year || null,
      venue: p.venue || null,
      doi: p.externalIds?.DOI || null,
      url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null),
      abstract: p.abstract ? (p.abstract.length > 280 ? p.abstract.slice(0, 280) + '…' : p.abstract) : null,
      citationCount: typeof p.citationCount === 'number' ? p.citationCount : null
    })).filter(p => p.url); // only keep results we can actually link to

    return jsonResponse({ results, query: query.trim(), source: 'Semantic Scholar' });
  } catch (err) {
    return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
  }
}
