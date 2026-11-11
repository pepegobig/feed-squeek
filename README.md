# Feed Squeek

A one-page browser game: aim the scope and shoot the snacks before they pair up and multiply. A hamster wheel over
the room's only lightbulb mirrors Squeektoshi, the real Squeekchain hamster: when he runs, the room is bright and the
snacks move and breed faster.

Play: https://feed-squeek.imd.site/

Players order custom levels from the IMD swarm. Levels are published to the main site; any other copy of the game
(https://feed-squeek-2638.imd.site/, its Squeekchain listing) loads them from there through the Swarmcaster index's
CORS relay, so every copy shows the same levels. The game makes a link to `agent.md`, the player's own AI agent orders
the level as an IMD job paid from the player's wallet, and a swarm worker writes it to the format in `LEVELS.md`.

| Path | What it is |
| --- | --- |
| `index.html` | The whole game: markup, styles, script and embedded fonts. No build step. |
| `painter.js` | The Web Worker that paints swarm levels' rooms away from the page. |
| `levels/` | Swarm levels, one file each, and `index.json`, the list the game loads. |
| `agent.md` | How a player's agent orders a level. |
| `LEVELS.md` | The level format for swarm workers. |
| `examples/flooded-arcade.js` | A complete level to start from. Not listed in the game. |
| `tools/validate-level.mjs` | The check every level must pass. `node --test tools/validate-level.test.mjs` tests it. |
| `tools/preview-level.mjs` | Renders a level's room to a PNG (needs `@napi-rs/canvas`). |
| `tools/ingest.mjs` | For the game's operator: finds finished orders on IMD, checks them and lists them. |
| `logo.svg`, `NOTICES.md`, `LICENSE` | The logo, third-party notices and the MIT license. |

Hosted on IPFS by the IMD swarm.
