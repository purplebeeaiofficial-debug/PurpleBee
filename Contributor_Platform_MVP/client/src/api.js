export async function postJson(baseUrl, path, payload) {
  const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`http-${response.status}:${text}`);
  }

  return await response.json();
}

export async function getJson(baseUrl, path) {
  const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}${path}`);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`http-${response.status}:${text}`);
  }
  return await response.json();
}
