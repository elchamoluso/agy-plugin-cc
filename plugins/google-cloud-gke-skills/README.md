# google-cloud-gke-skills

Las 28 skills `gke-*` de Google: creación de clústeres, upgrades, seguridad de plataforma y de workloads, redes, análisis de coste, y troubleshooting de IA sobre GPU/TPU.

**28 skills**, vendorizadas sin modificar desde
[`google/skills`](https://github.com/google/skills). Coste medido con `claude plugin details`:
**~5.091 tokens** en cada sesión mientras esté instalado.

**Por qué 28 y no 16.** Google archiva 12 de estas skills fuera de la categoría `Containers` (bajo Observability, Security, Networking y Storage), pero 17 de las 28 se citan entre sí por nombre en su propia descripción: `gke-basics` apunta a `gke-networking`, `gke-platform-security` y `gke-workload-security`, las tres fuera de `Containers`. Repartirlas por categoría dejaría referencias colgando, así que el corte es por prefijo `gke-`.

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
