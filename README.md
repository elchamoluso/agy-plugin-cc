# agy-plugin-cc — herramientas de Google para Claude Code

Un marketplace con seis plugins. `agy` puentea el Antigravity CLI de Google (modelos Gemini);
los otros cinco traen Google Workspace y los servidores MCP de Google.

```
/plugin marketplace add elchamoluso/agy-plugin-cc
```

| Plugin | Qué trae | Coste siempre-activo |
|---|---|---|
| **agy** | `/agy:ask`, `/agy:review`, `/agy:exec` — Gemini vía tu suscripción Antigravity, sin coste por token | ~200 tok |
| **google** | 44 skills de Workspace, `/google:doctor`, `/google:setup`, `/google:mcp` y el catálogo MCP | ~1,5k tok |
| **google-workspace-recipes** | 41 plantillas `recipe-*` y 10 playbooks `persona-*` | ~1,5k tok |
| **google-cloud-mcp** | gcloud, Cloud Run, Resource Manager, Developer Knowledge | ~57 KB de schema |
| **google-marketing-mcp** | Google Ads, Analytics (GA4), Search Console | pide credenciales al instalar |
| **google-data-mcp** | BigQuery + MCP Toolbox for Databases | ~133 KB de schema |

Instala solo lo que uses:

```
/plugin install google@agy-marketplace
/google:doctor
```

**Por qué los MCP van repartidos y no todos juntos:** los endpoints remotos de Google sirven su
lista de herramientas **sin autenticar** — 151 herramientas y ~1,6 MB de esquema entre los 13,
unos 400k tokens. Conectan "bien", cuestan contexto en cada sesión y solo fallan al llamar una
herramienta. Y Claude Code solo permite encender o apagar un plugin entero. Los detalles y el
tercer nivel de granularidad (`/google:mcp add <id>`, por proyecto) están en
[`plugins/google/README.md`](plugins/google/README.md).

## agy

Replica el patrón del plugin oficial [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
adaptado al contrato real de agy: invocaciones one-shot `--print`, resultados en JSON, sin runtime
persistente. Usa la suscripción Antigravity existente (OAuth) — sin coste por token.

### Requisitos

- Antigravity CLI instalado (`agy`, normalmente en `~/.local/bin`) y autenticado
  (correr `agy` una vez interactivo y completar el login de Google).
- Node ≥ 18. Git para `/agy:review`.

### Instalación

```
/plugin install agy@agy-marketplace
/agy:setup
```

Desde un clon local funciona igual: `/plugin marketplace add <ruta-del-clon>`.

Para desarrollo iterativo: `claude --plugin-dir <clon>/plugins/agy` + `/reload-plugins`.
Ojo: la instalación por marketplace COPIA el plugin a la caché de Claude Code; para recoger
cambios nuevos hay que `/plugin marketplace update agy-marketplace` y reinstalar.

### Comandos de agy

| Comando | Qué hace |
|---|---|
| `/agy:ask <prompt>` | Pregunta one-shot a Gemini. Sin acceso a ficheros (las tool calls se auto-deniegan en headless). |
| `/agy:continue <prompt>` | Continúa la conversación agy anterior de este proyecto (multi-turno real, por UUID, en su modelo original). Siempre SIN permisos de herramientas, aunque venga de un exec. |
| `/agy:exec <tarea>` | Delegación CON permisos totales (`--dangerously-skip-permissions`): agy puede leer/escribir ficheros y correr comandos. Solo invocable por el usuario. |
| `/agy:review [instrucciones]` | Segunda opinión de Gemini sobre el diff git actual (working tree, o `--base <ref>`). Review en español por defecto. |
| `/agy:models` | Lista los modelos disponibles. |
| `/agy:setup` | Comprueba binario + auth y corre un smoke test. |

Flags comunes (van ANTES del texto): `--model <alias>`, `--effort <low|medium|high>`,
`--timeout <segundos>` (default 420), `--conversation <uuid>`.

Modelo por defecto: **`gemini-3.1-pro-high`** (fijado en el plugin, no hereda del settings de agy).
Aliases: `pro` · `pro-low` · `flash` · `flash-high` · `flash-low` · `flash-3.5` · `sonnet` ·
`opus` · `gpt-oss`. `/agy:models` muestra la tabla completa.

`--effort` reescribe el sufijo del slug (`--model pro --effort low` → `gemini-3.1-pro-low`), no se
reenvía a agy: un slug de familia a secas se rechaza con *"requires --effort"* y un slug con
sufijo más `--effort` con *"conflicts"*, así que embeberlo es la única forma que siempre parsea.
`claude-sonnet-4-6` y `claude-opus-4-6-thinking` no tienen variantes de esfuerzo.

### Detalles de diseño de agy

- **Bug de flags de agy**: `--print` toma el prompt como VALOR del flag; si el siguiente token es
  otro flag, se lo traga como prompt. El companion siempre hace spawn con array argv y
  `--print=<prompt>` en un solo token — inambiguo por construcción. Booleanos siempre primero.
- **Sin stdin**: el prompt viaja por argv (límite Linux 128 KiB por argumento; los diffs de
  review se truncan a ~100 KiB con aviso).
- **Respuesta en JSON**: desde agy 1.1.10 el companion usa `--output-format=json`, que devuelve
  `{conversation_id, status, response, error, usage, num_turns}`. Dos trampas, ambas manejadas:
  un run fallido **igualmente sale con código 0** (manda `status`, no el exit code), y un
  `--conversation` inexistente se ignora en favor de una conversación nueva, cuyo id vuelve en el
  payload. Las versiones antiguas sin modo JSON siguen funcionando por una ruta de fallback.
  Contrapartida: JSON acumula hasta el final, así que un timeout ya no deja salida parcial.
- **Conversaciones**: el id viene en el JSON y se guarda **por raíz de repositorio**
  (`git rev-parse --show-toplevel`, con fallback a cwd fuera de un repo), de modo que `/agy:ask`
  en `src/` y `/agy:continue` en la raíz encuentran la misma conversación. `/agy:continue` reanuda
  con `--conversation <uuid>` explícito, nunca con el `-c` global.
- **Estado**: en `~/.cache/agy-plugin/conversations.json`, override con `AGY_PLUGIN_DATA`.
  A propósito **no** se usa `CLAUDE_PLUGIN_DATA`: el companion corre vía la herramienta Bash, que
  hereda el contexto de plugin que haya ambiente — medido aquí, apuntaba al directorio de datos de
  *otro* plugin.
- **Binario**: se resuelve explícitamente (`AGY_BIN` → `which agy` → `~/.local/bin` →
  `/usr/local/bin` → `/opt/homebrew/bin`) porque `~/.local/bin` falta del PATH de las shells
  no-login que hereda un Claude Code lanzado desde un launcher gráfico.
- **Timeout**: watchdog propio (timeout + 30s de gracia) con kill del process-group entero
  (agy spawnea procesos hijos); exit 124 al vencer.
- **Permisos**: en headless agy auto-deniega toda tool call salvo con
  `--dangerously-skip-permissions`. Solo `/agy:exec` lo pasa, y está marcado
  `disable-model-invocation` para que únicamente el usuario pueda lanzarlo. `/agy:continue`
  nunca hereda permisos (más cambios ⇒ nuevo `/agy:exec`).
- **Comandos mediados por Claude**: `ask`/`continue`/`exec`/`review` no pre-ejecutan
  `` !`…$ARGUMENTS` `` (backticks, `$` o comillas en el prompt romperían la línea bash); el .md
  instruye a Claude a componer la llamada Bash con el texto como UN argumento single-quoted.
  Solo `models` (sin texto del usuario) usa pre-ejecución; `setup` tampoco, porque su smoke test
  tarda hasta 90 s y la pre-ejecución `!` es síncrona y bloquea el ensamblado del prompt.

### Seguridad de agy

`/agy:exec` lanza agy con `--dangerously-skip-permissions`: dentro del directorio de trabajo,
agy puede **leer y escribir ficheros y ejecutar comandos** sin pedir permiso. Dos barreras
deliberadas, que conviene no quitar:

- `disable-model-invocation: true` en `exec.md` y `review.md` — Claude **no puede** dispararlos
  por su cuenta; solo tú, escribiendo el comando.
- `/agy:continue` nunca hereda permisos. Reanudar una conversación de `exec` es solo Q&A; para
  más cambios hace falta un `/agy:exec` nuevo y explícito.

La salida de agy se trata como un informe para ti, no como instrucciones para Claude.

## Licencia

Código propio MIT. `scripts/lib/git.mjs` y `scripts/lib/process.mjs` adaptados de
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0).
