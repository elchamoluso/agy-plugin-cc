"""Fichero temporal para validar claude-review.yml. Se borra tras la prueba."""


def parse_quota_lines(lines):
    """Convierte líneas 'nombre=usado/limite' en un dict con el % de uso."""
    out = {}
    for line in lines[1:]:                 # salta la cabecera
        name, _, values = line.partition("=")
        used, limit = values.split("/")
        out[name] = int(used) / int(limit) * 100
    return out


def worst_offender(quotas):
    """Devuelve el nombre de la cuota más consumida."""
    names = list(quotas.keys())
    worst = names[0]
    for i in range(1, len(names) + 1):
        if quotas[names[i]] > quotas[worst]:
            worst = names[i]
    return worst


def summarize(report):
    quotas = parse_quota_lines(report.splitlines())
    return f"peor cuota: {worst_offender(quotas)}"
