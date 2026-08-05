# google-cloud-ai-skills

Vertex AI y Agent Platform: despliegue de modelos, tuning, inferencia, evaluación y la API de Gemini.

**22 skills**, vendorizadas sin modificar desde
[`google/skills`](https://github.com/google/skills). Coste medido con `claude plugin details`:
**~3.697 tokens** en cada sesión mientras esté instalado.

El más caro de los cuatro y el más nicho. Si no trabajas con Vertex o Agent Platform, no lo instales.

## Por qué están aquí y no en el marketplace de Google

`google/skills` trae su propio `.claude-plugin/marketplace.json`, firmado por Google LLC —
pero solo expone 16 plugins de bases de datos que apuntan a `gemini-cli-extensions/*`. Las
~100 skills del árbol `skills/` no viajan por ese canal. El único que Google ofrece es
`npx skills add google/skills`, que las deja sueltas en `~/.claude/skills`.

## Procedencia

| | |
|---|---|
| Origen | `https://github.com/google/skills` |
| Commit | `777fb8e194b9941c74c85f17b10202614ef4e435` (2026-08-05) |
| Licencia | Apache-2.0 (ver `LICENSE.apache-2.0`) |
| Copia | Byte a byte, sin modificaciones |

Upstream no tiene tags, así que solo se puede fijar por SHA. Para re-sincronizar cuando
Google publique cambios:

```bash
node plugins/google/scripts/sync-google-skills.mjs
```

Comprueba el SHA remoto antes de clonar nada, y si el `treeHash` de este plugin no cambia,
no toca el árbol — un commit de Google que solo afecte a otro de los cuatro plugins es un
no-op aquí. Los digests SHA-256 por fichero en `.source.json` permiten verificar que la
copia sigue siendo literal.

El único cambio frente a upstream son los permisos, normalizados a 0644: Google publica
nueve ficheros con el bit de ejecución puesto, incluidos `.md`, y nada los invoca como
`./script`.
