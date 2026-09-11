function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(str) {
  if (!str) return '';
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return '';
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  try {
    const { code } = await context.request.json();
    if (!code || typeof code !== 'string') {
      return jsonResponse({ error: 'code is required' }, 400);
    }

    const encodedCode = utf8ToBase64(code);
    const resp = await fetch('https://ce.judge0.com/submissions?base64_encoded=true&wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_code: encodedCode, language_id: 71 }) // 71 = Python 3
    });
    const data = await resp.json();
    if (!resp.ok) {
      return jsonResponse({ error: data }, resp.status);
    }

    return jsonResponse({
      stdout: base64ToUtf8(data.stdout),
      stderr: base64ToUtf8(data.stderr),
      compile_output: base64ToUtf8(data.compile_output),
      status: data.status ? data.status.description : undefined
    });
  } catch (err) {
    return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
  }
}
