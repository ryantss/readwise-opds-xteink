# readwise-opds-xteink

Your [Readwise Reader](https://readwise.io/read) library as an OPDS catalog,
for reading on an Xteink e-reader running
[CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader) or
[CrossInk](https://github.com/uxjulia/CrossInk).

**Start with the idea:** [PROMPTS.md](PROMPTS.md) (what was asked) and
[PLAN.md](PLAN.md) (options, design, firmware constraints, verification).
The code is one way to realise it.

Browse Inbox, Shortlist, Later and Archive from the reader's OPDS browser and
download any article as an EPUB built on the fly: cleaned XHTML, images as
grayscale baseline JPEGs sized for the X3's 528×792 panel, the preview image
as cover. Runs as two serverless functions on Vercel; stores nothing.

- `/opds` – menu: Inbox, Shortlist, Later, Archive (HTTP Basic auth throughout)
- `/opds/inbox`, `/opds/shortlist`, `/opds/later`, `/opds/archive` – 50 per
  page, newest saved first (Reader's order). Inbox is Reader's `new` location.
- `/opds/books/<id>.epub` – one article as EPUB

PDFs, videos and highlights are left out – CrossPoint can't open them.

## Screenshots

Taken on an Xteink X3 running CrossPoint 1.6.5.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/1-home.png" alt="CrossPoint home screen showing the cover of a Readwise article and the OPDS Browser menu item">
      <br><sub><b>Home.</b> The article being read, with the cover built from its Readwise preview image. OPDS Browser opens the catalog.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/2-opds-servers.png" alt="OPDS Servers list with Readwise and Project Gutenberg">
      <br><sub><b>OPDS servers.</b> Readwise sits alongside any other catalog, here Project Gutenberg.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/3-shelves.png" alt="Readwise catalog menu listing Shortlist, Later and Archive">
      <br><sub><b>Shelves.</b> The catalog root: Shortlist, Later and Archive, one feed each.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/4-shortlist.png" alt="Shortlist feed listing article titles and authors">
      <br><sub><b>Shortlist.</b> Articles with their authors, 50 to a page. Download fetches the article as an EPUB.</sub>
    </td>
  </tr>
</table>

## Deploy

Needs a [Readwise access token](https://readwise.io/access_token) and a Vercel
account.

```sh
git clone https://github.com/chuyeow/readwise-opds-xteink.git
cd readwise-opds-xteink
npx vercel link                      # create a project
npx vercel env add READWISE_TOKEN production
npx vercel env add OPDS_USERNAME production
npx vercel env add OPDS_PASSWORD production
npx vercel deploy --prod
```

`OPDS_USERNAME`/`OPDS_PASSWORD` are what the reader sends; pick a long random
password. Optional `BASE_URL` overrides the origin used in feed links.
Functions are pinned to `sin1` (Singapore) in `vercel.json` so an X3 in
Singapore is not waiting on `iad1`.

## Reader

CrossPoint: Settings → Connectivity → OPDS Servers → Add Server, URL
`https://<your-project>.vercel.app/opds` plus the username and password. Easier
from a computer: put the reader in File Transfer mode, open
`http://crosspoint.local/settings`, and use the OPDS Servers card. Then Home →
OPDS Browser.

**"Failed to fetch feed"** (1.6.x shows this for every failure): check
`npx vercel logs requests` for a `CrossPoint-ESP32-*` user agent. None means
the reader never reached Vercel – re-check the URL.

## Develop

```sh
npm install
npm test                                           # core + handlers, network faked
node --env-file=.env.local scripts/dev-server.js   # http://localhost:8787/opds
```

`.env.local` holds `READWISE_TOKEN`, `OPDS_USERNAME`, `OPDS_PASSWORD`.

## Verify against CrossPoint and CrossInk

Needs `clang++` or `g++`, and libexpat. Both commands start a mocked Readwise catalog,
so they run without an account. They walk the menu, every shelf and its next
page, and one EPUB per shelf through the device parsers, then check XML
well-formedness and JPEG size. Non-zero exit on the first failed check.

```sh
npm run verify:crosspoint    # CrossPoint OpdsParser 1.6.5 + develop, ContentOpfParser
npm run verify:crossink      # CrossInk OpdsParser + ContentOpfParser, pinned to v1.6.1
                             # (9914146eeae7b46b300f475a16c32426fc02ec1f); also
                             # compares the same feeds against CrossPoint
npm run verify:crossink-limits  # HTTP/1.1 probe of firmware limits (chunked vs
                             # Content-Length, Content-Disposition, 60s timeout)
```

To walk a live deployment instead:

```sh
set -a; . ./.env.local; set +a
npm run verify:crosspoint -- https://<your-project>.vercel.app 1
npm run verify:crossink -- https://<your-project>.vercel.app 1
```

## License

[MIT](LICENSE)
