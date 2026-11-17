const base = 'https://api.nextmoe.dev/v2'
const j = async (p) => {
  const r = await fetch(base + p, { headers: { Accept: 'application/json' } })
  return [r.status, await r.json().catch(() => null), r.headers.get('x-request-id')]
}
for (const p of ['/catalog/works?refs=vndb:86&limit=5', '/catalog/works?refs=vndb%3A86&limit=5', '/catalog/works/5806?include=characters']) {
  const [status, body, rid] = await j(p)
  console.log('\n###', p, status, rid)
  if (body?.items) {
    console.log('items', body.items.length)
    for (const it of body.items) console.log(' -', it.id, it.display_name, JSON.stringify(it.sources)?.slice(0, 160))
  } else if (body) {
    console.log(JSON.stringify(body).slice(0, 400))
  }
}
