# agy-plugin-cc — Antigravity CLI (agy) para Claude Code

Expone `agy` (Antigravity CLI de Google, modelos Gemini) como herramienta invocable desde
Claude Code, replicando el patrón del plugin oficial [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
pero adaptado al contrato real de agy: invocaciones one-shot `--print`, texto plano por stdout,
sin runtime persistente. Usa la suscripción Antigravity existente (OAuth) — sin coste por token.

## Requisitos

- Antigravity CLI instalado (`agy`, normalmente en `~/.local/bin`) y autenticado
  (correr `agy` una vez interactivo y completar el login de Google).
- Node ≥ 18. Git para `/agy:review`.

## Instalación

Dentro de una sesión de Claude Code (o con `claude plugin …` desde la terminal):

```
/plugin marketplace add elchamoluso/agy-plugin-cc
/plugin install agy@agy-marketplace
/agy:setup
```

Desde un clon local funciona igual: `/plugin marketplace add <ruta-del-clon>`.

Para desarrollo iterativo: `claude --plugin-dir <clon>/plugins/agy` + `/reload-plugins`.
Ojo: la instalación por marketplace COPIA el plugin a la caché de Claude Code; para recoger
cambios nuevos hay que `/plugin marketplace update agy-marketplace` y reinstalar.

## Comandos

| Comando | Qué hace |
|---|---|
| `/agy:ask <prompt>` | Pregunta one-shot a Gemini. Sin acceso a ficheros (las tool calls se auto-deniegan en headless). |
| `/agy:continue <prompt>` | Continúa la conversación agy anterior de este proyecto (multi-turno real, por UUID, en su modelo original). Siempre SIN permisos de herramientas, aunque venga de un exec. |
| `/agy:exec <tarea>` | Delegación CON permisos totales (`--dangerously-skip-permissions`): agy puede leer/escribir ficheros y correr comandos. Solo invocable por el usuario. |
| `/agy:review [instrucciones]` | Segunda opinión de Gemini sobre el diff git actual (working tree, o `--base <ref>`). Review en español por defecto. |
| `/agy:models` | Lista los modelos disponibles. |
| `/agy:setup` | Comprueba binario + auth y corre un smoke test. |

Flags comunes (van ANTES del texto): `--model <alias>`, `--timeout <segundos>` (default 420),
`--conversation <uuid>`.

Modelo por defecto: **Gemini 3.1 Pro (High)** (fijado en el plugin, no hereda del settings de agy).
Aliases de modelo (los nombres completos llevan espacios y las comillas dobles no sobreviven al
plumbing de `$ARGUMENTS`; usa el alias): `pro` · `pro-low` · `flash` · `flash-high` · `flash-low`
· `sonnet` · `opus` · `gpt-oss`. `/agy:models` muestra la tabla completa.

## Detalles de diseño (por qué el companion existe)

- **Bug de flags de agy**: `--print` toma el prompt como VALOR del flag; si el siguiente token es
  otro flag, se lo traga como prompt. El companion siempre hace spawn con array argv y
  `--print=<prompt>` en un solo token — inambiguo por construcción. Booleanos siempre primero.
- **Sin stdin ni JSON**: el prompt viaja por argv (límite Linux 128 KiB por argumento; los diffs
  de review se truncan a ~100 KiB con aviso) y la respuesta es texto plano.
- **Conversaciones**: agy persiste cada conversación como `<uuid>.db` en
  `~/.gemini/antigravity-cli/conversations/`. El companion detecta el UUID creado por cada run
  (snapshot antes/después) y lo guarda por directorio de proyecto; `/agy:continue` reanuda con
  `--conversation <uuid>` explícito, nunca con el `-c` global.
- **Timeout**: watchdog propio (timeout + 30s de gracia) con kill del process-group entero
  (agy spawnea procesos hijos); exit 124 al vencer.
- **Permisos**: en headless agy auto-deniega toda tool call salvo con
  `--dangerously-skip-permissions`. Solo `/agy:exec` lo pasa, y está marcado
  `disable-model-invocation` para que únicamente el usuario pueda lanzarlo. `/agy:continue`
  nunca hereda permisos (más cambios ⇒ nuevo `/agy:exec`).
- **Comandos mediados por Claude**: `ask`/`continue`/`exec`/`review` no pre-ejecutan
  `` !`…$ARGUMENTS` `` (backticks, `$` o comillas en el prompt romperían la línea bash); el .md
  instruye a Claude a componer la llamada Bash con el texto como UN argumento single-quoted.
  Solo `models` y `setup` (sin texto del usuario) usan pre-ejecución.

## Licencia

Código propio MIT. `scripts/lib/args.mjs` y `scripts/lib/process.mjs` adaptados de
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0).
