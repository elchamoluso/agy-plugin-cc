# google

El plugin paraguas de Google para Claude Code: skills de Workspace, arranque de credenciales y el
catálogo de servidores MCP de Google.

**No trae ningún servidor MCP.** Es deliberado, y es lo que hace que se pueda tener siempre puesto.

## Por qué el catálogo está inerte

Medido el 2026-08-05 contra los endpoints reales:

| Servidor remoto | tools | schema |
|---|---:|---:|
| Cloud SQL | 15 | 465 KB |
| Compute Engine | 29 | 253 KB |
| AlloyDB | 17 | 193 KB |
| Spanner | 15 | 165 KB |
| Firestore | 15 | 150 KB |
| BigQuery | 6 | 130 KB |
| GKE | 23 | 56 KB |
| Gmail | 13 | 45 KB |
| Bigtable | 1 | 44 KB |
| Cloud Run | 5 | 43 KB |
| Drive | 8 | 23 KB |
| Resource Manager | 1 | 7 KB |
| Developer Knowledge | 3 | 6 KB |
| **Total** | **151** | **~1,6 MB ≈ 400k tokens** |

Los `https://<api>.googleapis.com/mcp` responden `initialize` y `tools/list` **sin credenciales**.
Es decir: un servidor mal configurado no falla — conecta, vuelca su esquema entero en cada sesión y
solo revienta cuando de verdad llamas a una herramienta. Y Claude Code no permite apagar servidores
sueltos dentro de un plugin, solo el plugin entero.

Por eso: el catálogo vive aquí como datos, y los servidores se activan en otro sitio.

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

`/google:doctor` distingue tres estados, y el del medio es el importante: **`REACHABLE, NOT
AUTHORISED`** significa que el servidor conecta y cuesta contexto pero no sirve para nada todavía.

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
