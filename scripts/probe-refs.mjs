const base = 'https://api.nextmoe.dev/v2'
const get = async (p) => {
  const r = await fetch(base + p, { headers: { Accept: 'application/json' } })
  const t = await r.text()
  console.log('\n###', p, r.status)
  try {
    const j = JSON.parse(t)
    if (j.items) {
      console.log('items:', j.items.length)
      for (const it of j.items.slice(0, 6)) {
        console.log(' -', it.id, '|', it.display_name, '|', it.target_object || it.object, '|', (it.sources || []).map(s => `${s.source}:${s.external_id ?? s.value ?? ''}`).join(','))
      }
    } else {
      console.log(JSON.stringify(j).slice(0, 600))
    }
  } catch {
    console.log(t.slice(0, 300))
  }
}

await get('/catalog/works?refs=vndb:v86')
await get('/catalog/search?q=CLANNAD&object=work&limit=3')
await get('/catalog/works/86')
