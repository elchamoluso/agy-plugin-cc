# google

El plugin paraguas de Google para Claude Code: skills de Workspace, arranque de credenciales y el
catálogo de servidores MCP de Google.

**No trae ningún servidor MCP.** Es deliberado, y es lo que hace que se pueda tener siempre puesto.

## Por qué el catálogo está inerte

Medido el 2026-08-05 contra los endpoints reales. Los ocho más caros de los 28 remotos
verificados:

| Servidor remoto | tools | schema |
|---|---:|---:|
| Security Operations (Chronicle) | 70 | 3.720 KB |
| Cloud SQL Admin | 15 | 465 KB |
| Pub/Sub | 15 | 334 KB |
| Cloud Monitoring | 9 | 332 KB |
| Compute Engine | 29 | 253 KB |
| AlloyDB | 17 | 193 KB |
| Spanner | 15 | 165 KB |
| Dataproc | 16 | 159 KB |
| **Los 28 juntos** | **316** | **~6,5 MB** |

Chronicle solo ya son 3,7 MB, más de la mitad del total.

Los `https://<api>.googleapis.com/mcp` responden `initialize` y `tools/list` **sin credenciales**.
Es decir: un servidor mal configurado no falla — conecta, vuelca su esquema entero en cada sesión y
solo revienta cuando de verdad llamas a una herramienta. Y Claude Code no permite apagar servidores
sueltos dentro de un plugin, solo el plugin entero.

Por eso: el catálogo vive aquí como datos, y los servidores se activan en otro sitio.

El catálogo tiene 66 entradas, pero solo las **37 verificadas** — sondeadas, con `toolCount`,
`schemaBytes` y `measuredAt` — salen en `list` y las acepta `add`. Las 29 restantes vienen de la
página de productos soportados de Google y nadie las ha medido: se ven con `list --all` y `add`
las rechaza. Sin esa distinción, triplicar el catálogo habría diluido su única promesa, que las
cifras son mediciones.

## Tres niveles de activación

1. **Plugin** — `/plugin install google-cloud-mcp@agy-marketplace`. Global, grueso.
2. **Por proyecto** — `enabledPlugins` en el `.claude/settings.json` del repo. La precedencia
   `project > user` hace que solo ese repo pague el coste.
3. **Por servidor** — `/google:mcp add spanner` escribe en el `.mcp.json` del proyecto, que sí
   tiene control por servidor. Es la granularidad fina.

## Comandos

| Comando | Qué hace |
|---|---|
| `/google:doctor` | Diagnóstico de solo lectura: binarios, ADC, scopes, `gws`, y si cada MCP remoto responde. |
| `/google:setup` | Arranque: toolchain, ADC con scopes unificados, login de `gws`, cliente OAuth. |
| `/google:scopes` | Diffea los scopes concedidos contra los que pide el catálogo. |
| `/google:mcp` | `list` · `add <id>…` · `remove <id>…` · `status`. |

`/google:doctor` distingue tres estados, y el del medio es el importante: **`REACHABLE`**
significa que el servidor conecta y cuesta contexto, no que sirva para algo. Como `tools/list`
responde sin credenciales, un listado correcto no dice nada sobre si las llamadas funcionarán;
el doctor añade el remedio según el tipo de auth, que no es el mismo para OAuth que para API key.

Por defecto solo sondea los servidores habilitados en el proyecto (o los que vengan en un plugin,
si no hay ninguno), de seis en seis. `--probe-all` barre el catálogo entero y `--probe=<id>` mide
uno suelto — que es como se asciende una entrada de `listed` a `verified`.

## La excepción: Maps Grounding Lite

`maps-grounding-lite` autentica con **API key en cabecera**, no con OAuth. Es el único servidor
remoto del catálogo que funciona de punta a punta sin montar un cliente OAuth propio, así que es
con el que conviene probar que la cadena entera va:

```bash
gcloud services enable mapstools.googleapis.com
export GOOGLE_MAPS_API_KEY=...        # restringida a Maps Tools API en la consola
/google:mcp add maps-grounding-lite
```

Esa clave es una credencial portadora: restríngela en la consola.

## El problema del OAuth

`accounts.google.com` **no expone `registration_endpoint`**: no soporta Dynamic Client
Registration, que es como Claude Code se registraría solo. Hay que crear un cliente OAuth propio en
la consola de GCP y pasarlo:

```bash
claude mcp add --transport http resource-manager \
  https://cloudresourcemanager.googleapis.com/mcp \
  --client-id <id> --client-secret --callback-port 8765
```

Prueba primero con `resource-manager` — 1 herramienta, 7 KB. Si el flujo no funciona, lo descubres
sin haber pagado nada.

## Las 44 skills

Salen de `gws generate-skills`, nunca se escriben a mano. Para actualizarlas cuando
`googleworkspace/cli` publique una versión:

```bash
node scripts/sync-gws-skills.mjs           # avisa si ya están sincronizadas
node scripts/sync-gws-skills.mjs --force
```

Genera a un temporal y solo sustituye el árbol real si la salida tiene sentido: generar in-place
dejaría el plugin a medias si el CLI muriera por el camino.

Las 41 `recipe-*` y 10 `persona-*` viven en `google-workspace-recipes`, aparte, porque son
plantillas y no capacidades — y duplicarían el coste base del hub.

`gws` **no tiene servidor MCP**: lo quitaron en la 0.8.0 porque exponía 200-400 herramientas sobre
la Discovery API. Estas skills lo sustituyen a una fracción del coste.

### Migrar desde symlinks

Si tenías las skills enlazadas a mano desde un clone de `googleworkspace/cli`:

```bash
node scripts/unlink-legacy-skills.mjs            # dry run
node scripts/unlink-legacy-skills.mjs --apply
```

Solo borra symlinks que resuelvan dentro del clone y que el plugin ya reemplace. Instala el plugin
con alcance `user` **antes** de aplicarlo, o te quedarás sin las skills fuera del proyecto actual.

## Plugins de Google que NO vendorizamos

Google publica cosas que ya son plugins de Claude Code instalables. Duplicarlas aquí forkaría su
ritmo de releases a cambio de nada, así que se documentan y punto.

| Qué | Cómo se instala | Aviso |
|---|---|---|
| **Marketplace `google-plugins`** — 16 plugins de bases de datos firmados por Google LLC (AlloyDB, Spanner, Looker, BigQuery, Cloud SQL, Firestore, Oracle…) | `/plugin marketplace add google/skills` | **Solapa fuerte con `google-data-mcp`.** No enciendas los dos. |
| **`sre`** — 16 skills de SRE para GCP: investigación de incidentes, gráficas de monitorización, post-mortems | `/plugin marketplace add gemini-cli-extensions/sre` y luego `/plugin install sre-extension@sre` | Trae skills `cloud-logging`, `cloud-monitoring` y `gcp-setup` que **pisan** `google-cloud-skills` y `/google:setup`. Su `plugin.json` se llama `sre-extension`, no `sre`. |
| **`chrome-devtools-mcp`** — depurar, perfilar e inspeccionar red de páginas reales | `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp` | Su `plugin.json` fija `@1.6.0` y va por detrás de npm. La entrada `chrome-devtools` del catálogo apunta a `@latest`; elige una vía, no las dos. |
| **`clasp`** — MCP de Apps Script | `/google:mcp add clasp` | `google/clasp` trae `plugin.json` pero **no** `marketplace.json`, así que `/plugin marketplace add google/clasp` falla. Por eso va por el catálogo. |

Ojo con el marketplace de Google: `.claude-plugin/marketplace.json` sirve **solo** esos 16
plugins de datos. Las ~100 skills del árbol `skills/` no viajan por ahí — están vendorizadas en
`google-cloud-skills`, `google-cloud-gke-skills`, `google-cloud-ai-skills` y `google-ads-skills`.
