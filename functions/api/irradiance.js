function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function parseMonthly(data) {
  const monthlyArr = data?.outputs?.monthly?.fixed || data?.outputs?.monthly || null;
  if (!Array.isArray(monthlyArr)) return null;

  const result = monthlyArr.map(entry => {
    const month = entry.month ?? entry.Month ?? null;
    let irr = null;
    for (const key of Object.keys(entry)) {
      if (/^H\(/i.test(key) && /_m$/i.test(key)) { irr = entry[key]; break; }
    }
    if (irr === null) {
      for (const key of Object.keys(entry)) {
        if (/^H\(/i.test(key)) { irr = entry[key]; break; }
      }
    }
    return { month, irradiation: irr };
  }).filter(m => m.month !== null && m.irradiation !== null && !isNaN(m.irradiation));

  return result.length ? result : null;
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

    const { lat, lon } = await context.request.json();
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude)) {
      return jsonResponse({ error: 'Valid lat and lon are required' }, 400);
    }

    const url = 'https://re.jrc.ec.europa.eu/api/v5_2/MRcalc?' + new URLSearchParams({
      lat: latitude,
      lon: longitude,
      horirrad: '1',
      outputformat: 'json'
    });

    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const text = await resp.text();

    if (!resp.ok) {
      return jsonResponse({ error: `PVGIS API error (${resp.status})`, detail: text.slice(0, 300) }, 502);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return jsonResponse({ error: 'PVGIS returned a non-JSON response', detail: text.slice(0, 300) }, 502);
    }

    const monthly = parseMonthly(data);
    if (!monthly) {
      // Parsing shape mismatch — return raw so the issue can be diagnosed and fixed
      return jsonResponse({ error: 'Could not parse PVGIS response shape', raw: data }, 200);
    }

    // MRcalc's H(h)_m fields are MONTHLY TOTALS (kWh/m²/month), not daily averages.
    // Convert each to a daily figure, then average across the year using total days.
    const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const monthlyDaily = monthly.map(m => {
      const idx = Math.max(0, Math.min(11, Math.round(m.month) - 1));
      const days = DAYS_IN_MONTH[idx];
      return { month: m.month, irradiation: Math.round((m.irradiation / days) * 100) / 100 };
    });
    const totalAnnual = monthly.reduce((sum, m) => sum + m.irradiation, 0);
    const annualAverage = totalAnnual / 365;

    return jsonResponse({
      location: { lat: latitude, lon: longitude },
      monthly: monthlyDaily,
      annualAveragePeakSunHours: Math.round(annualAverage * 100) / 100,
      source: 'PVGIS (European Commission)'
    });
  } catch (err) {
    return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
  }
}
