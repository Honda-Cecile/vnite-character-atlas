const base = 'https://api.nextmoe.dev/v2'
const j = async (p) => {
  const r = await fetch(base + p, { headers: { Accept: 'application/json' } })
  return [r.status, await r.json().catch(() => null)]
}
for (const p of ['/catalog/works?refs=vndb:V86&limit=5', '/catalog/works?refs=vndb:v86&limit=5', '/catalog/works/5806']) {
  const [status, body] = await j(p)
  console.log('\n###', p, status)
  if (body?.items) {
    console.log('items', body.items.length)
    for (const it of body.items) console.log(' -', it.id, it.display_name, JSON.stringify(it.localized)?.slice(0, 120))
  } else if (body) {
    console.log('id', body.id, '|', body.display_name, '|', JSON.stringify(body.localized)?.slice(0, 200))
  }
}
